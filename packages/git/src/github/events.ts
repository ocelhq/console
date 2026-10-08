import type { GitEvent, RepoRef, WebhookRequest } from "../provider";

interface Payload {
  action?: string;
  ref?: string;
  after?: string;
  deleted?: boolean;
  number?: number;
  installation?: { id: number; account?: { login?: string } };
  repository?: { id: number; full_name: string };
  pull_request?: { head: { sha: string; ref: string }; merged?: boolean };
}

function repoOf(payload: Payload): RepoRef | undefined {
  const repository = payload.repository;
  return repository && { id: String(repository.id), fullName: repository.full_name };
}

const BRANCH_PREFIX = "refs/heads/";

export function parseGithubEvent(request: WebhookRequest): GitEvent | undefined {
  const name = request.headers.get("x-github-event");
  const payload = JSON.parse(request.body) as Payload;
  const installation = payload.installation && String(payload.installation.id);
  if (!installation) return undefined;

  if (name === "installation") {
    if (payload.action === "created") {
      return {
        type: "installed",
        installation,
        account: payload.installation?.account?.login ?? "",
      };
    }
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
    };
  }

  if (name === "pull_request" && payload.pull_request && payload.number !== undefined) {
    const { head, merged } = payload.pull_request;
    const pr = payload.number;
    if (payload.action === "opened" || payload.action === "reopened") {
      return { type: "pr_opened", installation, repo, pr, sha: head.sha, branch: head.ref };
    }
    if (payload.action === "synchronize") {
      return { type: "pr_sync", installation, repo, pr, sha: head.sha, branch: head.ref };
    }
    if (payload.action === "closed") {
      return { type: "pr_closed", installation, repo, pr, merged: merged === true };
    }
  }
  return undefined;
}
