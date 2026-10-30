import { configuredGit, forgetExpiredPipelineTokens } from "@console/git";
import { task } from "ocel/task";
import { resync } from "../changes";
import type { JobDeps } from "../deps";
import { type GitEventPayload, handleGitEvent } from "../events";
import { gitTokens } from "../git-token";
import { runnerCalls } from "../runner";
import {
  notifyJobChanged,
  queueGitEvent,
  type SyncPayload,
  syncFailure,
  type Triggers,
} from "../runtime";
import { sweepJobs } from "../sweep";
import { linkedRepo, syncJob } from "../sync";

function git() {
  const runtime = configuredGit();
  if (!runtime) throw new Error("Git integrations are not configured: set CONSOLE_ENCRYPTION_KEY");
  return runtime;
}

export const gitEvent = task<GitEventPayload>("git-event", {
  ordered: true,
  retry: { maxAttempts: 5, minDelay: "5s", maxDelay: "5m" },
  run: async (payload) => {
    const runtime = git();
    await handleGitEvent(payload, {
      store: runtime.store,
      readFile: async (appId, installation, repo, file) => {
        const app = await runtime.store.loadApp(appId);
        if (!app) throw new Error(`git app ${appId} is gone`);
        return runtime.providerFor(app).readFile(installation, repo, file);
      },
      ...jobDeps(),
    });
  },
});

export const gitSync = task<SyncPayload>("git-sync", {
  ordered: true,
  retry: { maxAttempts: 5, minDelay: "10s", maxDelay: "2m" },
  catchError: ({ error }) => syncFailure(error),
  run: async (payload) => {
    await syncJob(payload.jobId, git());
  },
});

export const jobSweep = task("job-sweep", {
  cron: "* * * * *",
  retry: { maxAttempts: 1 },
  run: async () => {
    try {
      await sweepJobs(jobDeps());
    } finally {
      await resync(jobChanged);
    }
  },
});

export const pipelineTokenSweep = task("pipeline-token-sweep", {
  cron: "*/15 * * * *",
  retry: { maxAttempts: 1 },
  run: async () => {
    await forgetExpiredPipelineTokens();
  },
});

const triggers: Triggers = {
  gitEvent: (payload, options) => gitEvent.trigger(payload, options),
  gitSync: (payload, options) => gitSync.trigger(payload, options),
};

export const jobChanged = notifyJobChanged(triggers, linkedRepo);

export const webhookEvents = queueGitEvent(triggers);

export function jobDeps(): JobDeps {
  return {
    runners: runnerCalls,
    notify: jobChanged,
    gitToken: gitTokens(configuredGit),
  };
}
