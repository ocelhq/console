import { configuredGit, forgetExpiredPipelineTokens } from "@console/git";
import { task } from "ocel/task";
import { type GitEventPayload, handleGitEvent } from "../events";
import { jobQueue } from "../queue";
import {
  notifyJobChanged,
  queueGitEvent,
  type SyncPayload,
  syncFailure,
  type Triggers,
} from "../runtime";
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
    await handleGitEvent(payload, { store: git().store, notify: jobChanged });
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

export const leaseSweep = task("lease-sweep", {
  cron: "* * * * *",
  retry: { maxAttempts: 1 },
  run: async () => {
    const queue = runnerQueue();
    try {
      await queue.sweep();
    } finally {
      try {
        await queue.resync();
      } finally {
        await forgetExpiredPipelineTokens();
      }
    }
  },
});

const triggers: Triggers = {
  gitEvent: (payload, options) => gitEvent.trigger(payload, options),
  gitSync: (payload, options) => gitSync.trigger(payload, options),
};

export const jobChanged = notifyJobChanged(triggers, linkedRepo);

export const webhookEvents = queueGitEvent(triggers);

export const runnerQueue = () => jobQueue({ notify: jobChanged });
