import type { Job } from "@console/db/schema";
import type { GitEvent, GitEventHandler } from "@console/git";
import { type GitEventPayload, toWire } from "./events";

export interface SyncPayload {
  jobId: string;
}

export interface Triggers {
  gitEvent(payload: GitEventPayload, options: { key: string }): Promise<unknown>;
  gitSync(
    payload: SyncPayload,
    options: { key: string; idempotencyKey: string; idempotencyKeyTTL: "1h" },
  ): Promise<unknown>;
}

export interface LinkedRepo {
  installationId: string;
  repoId: string;
}

function eventKey(appId: string, event: Exclude<GitEvent, { type: "uninstalled" }>): string {
  const scope = event.type === "push" ? event.branch : `pr-${event.pr}`;
  return `${appId}:${event.repo.id}#${scope}`;
}

export function queueGitEvent(triggers: Triggers): GitEventHandler {
  return async (event, context) => {
    if (event.type === "uninstalled") return;
    await triggers.gitEvent(
      { deliveryId: context.deliveryId, appId: context.app.id, event: toWire(event) },
      { key: eventKey(context.app.id, event) },
    );
  };
}

function syncKey(job: Job, repo: LinkedRepo | undefined): string {
  if (job.kind === "deploy") return `${job.projectId}#${job.sha}`;
  const scope = repo ? `${repo.installationId}:${repo.repoId}` : job.projectId;
  return `${scope}#pr-${job.pr}`;
}

export function notifyJobChanged(
  triggers: Triggers,
  linkedRepo: (projectId: string) => Promise<LinkedRepo | undefined>,
): (changed: Job) => Promise<void> {
  return async (changed) => {
    const repo = changed.kind === "deploy" ? undefined : await linkedRepo(changed.projectId);
    await triggers.gitSync(
      { jobId: changed.id },
      {
        key: syncKey(changed, repo),
        idempotencyKey: `${changed.id}@${changed.revision}`,
        idempotencyKeyTTL: "1h",
      },
    );
  };
}

const RETRYABLE_CLIENT_ERRORS = new Set([408, 429]);

export function syncFailure(error: unknown): { skipRetrying: true } | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return undefined;
  const refused = status >= 400 && status < 500 && !RETRYABLE_CLIENT_ERRORS.has(status);
  return refused ? { skipRetrying: true } : undefined;
}
