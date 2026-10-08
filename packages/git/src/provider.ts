export interface RepoRef {
  id: string;
  fullName: string;
}

export interface Repo extends RepoRef {
  defaultBranch: string;
}

export interface InstallationRef {
  externalId: string;
}

export interface WebhookRequest {
  headers: Headers;
  body: string;
}

export class MalformedWebhook extends Error {}

interface PullRequest {
  installation: string;
  repo: RepoRef;
  pr: number;
  sha: string;
  branch: string;
  draft: boolean;
  fork: boolean;
  at: Date;
}

export type GitEvent =
  | {
      type: "push";
      installation: string;
      repo: RepoRef;
      branch: string;
      sha: string;
      deleted: boolean;
      at: Date;
    }
  | ({ type: "pr_opened"; reopened: boolean } & PullRequest)
  | ({ type: "pr_sync" } & PullRequest)
  | {
      type: "pr_closed";
      installation: string;
      repo: RepoRef;
      pr: number;
      merged: boolean;
      at: Date;
    }
  | { type: "uninstalled"; installation: string };

export type CommitState = "pending" | "success" | "failure" | "error";

export type DeploymentState = "queued" | "in_progress" | "success" | "failure" | "inactive";

export interface RepoToken {
  token: string;
  expiresAt: Date;
}

export interface UserInstallation {
  externalId: string;
  account: string;
}

export interface GitProvider {
  verifyWebhook(request: WebhookRequest): Promise<boolean>;
  deliveryId(request: WebhookRequest): string | undefined;
  parseEvent(request: WebhookRequest): GitEvent | undefined;
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  administeredInstallations(input: {
    code: string;
    redirectUri: string;
  }): Promise<UserInstallation[]>;
  listRepos(installation: InstallationRef): Promise<Repo[]>;
  repoToken(installation: InstallationRef, repo: RepoRef, access: "read"): Promise<RepoToken>;
  setStatus(
    installation: InstallationRef,
    repo: RepoRef,
    status: {
      sha: string;
      state: CommitState;
      context: string;
      description?: string;
      targetUrl?: string;
    },
  ): Promise<void>;
  upsertComment(
    installation: InstallationRef,
    repo: RepoRef,
    comment: { pr: number; marker: string; body: string },
  ): Promise<void>;
  upsertDeployment(
    installation: InstallationRef,
    repo: RepoRef,
    deployment: {
      environment: string;
      state: DeploymentState;
      sha?: string;
      logUrl?: string;
      environmentUrl?: string;
    },
  ): Promise<void>;
}
