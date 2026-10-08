import { type GitEvent, MalformedWebhook, type RepoRef, type WebhookRequest } from "../provider";

interface Payload {
  action?: string;
  ref?: string;
  after?: string;
  deleted?: boolean;
  number?: number;
  installation?: { id: number };
  repository?: { id: number; full_name: string; pushed_at?: number };
  pull_request?: {
    head: { sha: string; ref: string; repo?: { id: number } | null };
    merged?: boolean;
    draft?: boolean;
    updated_at?: string;
  };
}

function timeOf(value: number | string | undefined, what: string): Date {
  const at = typeof value === "number" ? new Date(value * 1000) : new Date(value ?? Number.NaN);
  if (Number.isNaN(at.getTime())) throw new MalformedWebhook(`the ${what} has no time`);
  return at;
}

function repoOf(payload: Payload): RepoRef | undefined {
  const repository = payload.repository;
  return repository && { id: String(repository.id), fullName: repository.full_name };
}

function payloadOf(request: WebhookRequest): Payload {
  let json: string | null = request.body;
  if (request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    json = new URLSearchParams(request.body).get("payload");
  }
  if (!json) throw new MalformedWebhook("the delivery has no payload");
  try {
    const payload: unknown = JSON.parse(json);
    if (typeof payload !== "object" || payload === null) throw new Error("not an object");
    return payload as Payload;
  } catch {
    throw new MalformedWebhook("the delivery's payload is not a JSON object");
  }
}

const BRANCH_PREFIX = "refs/heads/";

export function parseGithubEvent(request: WebhookRequest): GitEvent | undefined {
  const name = request.headers.get("x-github-event");
  const payload = payloadOf(request);
  const installation = payload.installation && String(payload.installation.id);
  if (!installation) return undefined;

  if (name === "installation") {
    if (payload.action === "deleted") return { type: "uninstalled", installation };
    return undefined;
  }

  const repo = repoOf(payload);
  if (!repo) return undefined;

  if (name === "push") {
    if (!payload.ref?.startsWith(BRANCH_PREFIX) || !payload.after) return undefined;
    return {
      type: "push",
      installation,
      repo,
      branch: payload.ref.slice(BRANCH_PREFIX.length),
      sha: payload.after,
      deleted: payload.deleted === true,
      at: timeOf(payload.repository?.pushed_at, "push"),
    };
  }

  if (name === "pull_request" && payload.pull_request && payload.number !== undefined) {
    const { head, merged, draft, updated_at } = payload.pull_request;
    const pr = payload.number;
    const at = timeOf(updated_at, "pull request");
    const opened = {
      installation,
      repo,
      pr,
      sha: head.sha,
      branch: head.ref,
      draft: draft === true,
      fork: head.repo?.id !== payload.repository?.id,
      at,
    };
    if (payload.action === "opened" || payload.action === "ready_for_review") {
      return { type: "pr_opened", reopened: false, ...opened };
    }
    if (payload.action === "reopened") return { type: "pr_opened", reopened: true, ...opened };
    if (payload.action === "synchronize") return { type: "pr_sync", ...opened };
    if (payload.action === "closed") {
      return { type: "pr_closed", installation, repo, pr, merged: merged === true, at };
    }
  }
  return undefined;
}
