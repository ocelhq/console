export interface RepoRef {
  id: string;
  fullName: string;
}

export interface InstallationRef {
  externalId: string;
}

export interface WebhookRequest {
  headers: Headers;
  body: string;
}

export type GitEvent =
  | {
      type: "push";
      installation: string;
      repo: RepoRef;
      branch: string;
      sha: string;
      deleted: boolean;
    }
  | {
      type: "pr_opened";
      installation: string;
      repo: RepoRef;
      pr: number;
      sha: string;
      branch: string;
    }
  | {
      type: "pr_sync";
      installation: string;
      repo: RepoRef;
      pr: number;
      sha: string;
      branch: string;
    }
  | { type: "pr_closed"; installation: string; repo: RepoRef; pr: number; merged: boolean }
  | { type: "installed"; installation: string; account: string }
  | { type: "uninstalled"; installation: string };

export type CommitState = "pending" | "success" | "failure" | "error";

export type DeploymentState = "in_progress" | "success" | "failure" | "inactive";

export interface RepoToken {
  token: string;
  expiresAt: Date;
}

export interface GitProvider {
  verifyWebhook(request: WebhookRequest): Promise<boolean>;
  parseEvent(request: WebhookRequest): GitEvent | undefined;
  listRepos(installation: InstallationRef): Promise<RepoRef[]>;
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
