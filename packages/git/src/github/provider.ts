import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import type { DeploymentState, GitProvider, InstallationRef, RepoRef } from "../provider";
import { parseGithubEvent } from "./events";

export interface GithubCredentials {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

export interface GithubOptions {
  fetch?: typeof fetch;
}

const PAGE = 100;

interface DeploymentStatus {
  state: DeploymentState;
  log_url?: string;
  environment_url?: string;
  auto_inactive?: boolean;
}

function split(repo: RepoRef): { owner: string; repo: string } {
  const [owner, name] = repo.fullName.split("/");
  if (!owner || !name) throw new Error(`invalid repo '${repo.fullName}'`);
  return { owner, repo: name };
}

async function everyPage<T>(page: (number: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let number = 1; ; number++) {
    const items = await page(number);
    all.push(...items);
    if (items.length < PAGE) return all;
  }
}

export function githubProvider(
  credentials: GithubCredentials,
  options: GithubOptions = {},
): GitProvider {
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    webhooks: { secret: credentials.webhookSecret },
    Octokit: options.fetch ? Octokit.defaults({ request: { fetch: options.fetch } }) : Octokit,
  });

  const as = (installation: InstallationRef) =>
    app.getInstallationOctokit(Number(installation.externalId));

  async function deploymentsOf(
    octokit: Awaited<ReturnType<typeof as>>,
    target: { owner: string; repo: string },
    environment: string,
    sha?: string,
  ) {
    return everyPage(async (page) => {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/deployments", {
        ...target,
        environment,
        sha,
        per_page: PAGE,
        page,
      });
      return data;
    });
  }

  return {
    async verifyWebhook({ headers, body }) {
      const signature = headers.get("x-hub-signature-256");
      if (!signature) return false;
      return app.webhooks.verify(body, signature);
    },

    parseEvent: parseGithubEvent,

    async listRepos(installation) {
      const octokit = await as(installation);
      const repos = await everyPage(async (page) => {
        const { data } = await octokit.request("GET /installation/repositories", {
          per_page: PAGE,
          page,
        });
        return data.repositories;
      });
      return repos.map((repo) => ({ id: String(repo.id), fullName: repo.full_name }));
    },

    async repoToken(installation, repo, access) {
      const { data } = await app.octokit.request(
        "POST /app/installations/{installation_id}/access_tokens",
        {
          installation_id: Number(installation.externalId),
          repositories: [split(repo).repo],
          permissions: { contents: access },
        },
      );
      return { token: data.token, expiresAt: new Date(data.expires_at) };
    },

    async setStatus(installation, repo, status) {
      const octokit = await as(installation);
      await octokit.request("POST /repos/{owner}/{repo}/statuses/{sha}", {
        ...split(repo),
        sha: status.sha,
        state: status.state,
        context: status.context,
        description: status.description,
        target_url: status.targetUrl,
      });
    },

    async upsertComment(installation, repo, { pr, marker, body }) {
      const octokit = await as(installation);
      const target = split(repo);
      const comments = await everyPage(async (page) => {
        const { data } = await octokit.request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
          { ...target, issue_number: pr, per_page: PAGE, page },
        );
        return data;
      });
      const sticky = comments.find(
        (comment) => comment.user?.type === "Bot" && comment.body?.includes(marker),
      );
      if (sticky) {
        await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          ...target,
          comment_id: sticky.id,
          body,
        });
        return;
      }
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        ...target,
        issue_number: pr,
        body,
      });
    },

    async upsertDeployment(installation, repo, deployment) {
      const octokit = await as(installation);
      const target = split(repo);
      const report = (id: number, status: DeploymentStatus) =>
        octokit.request("POST /repos/{owner}/{repo}/deployments/{deployment_id}/statuses", {
          ...target,
          deployment_id: id,
          ...status,
        });

      if (deployment.state === "inactive" && !deployment.sha) {
        for (const existing of await deploymentsOf(octokit, target, deployment.environment)) {
          await report(Number(existing.id), { state: "inactive" });
        }
        return;
      }

      if (!deployment.sha) throw new Error("a deployment needs the commit it deploys");
      const sha = deployment.sha;
      const existing = (await deploymentsOf(octokit, target, deployment.environment, sha)).find(
        (candidate) => candidate.sha === sha,
      );
      const id = existing
        ? Number(existing.id)
        : await createDeployment(octokit, target, deployment.environment, sha);
      await report(id, statusFor(deployment));
    },
  };
}

async function createDeployment(
  octokit: Awaited<ReturnType<App["getInstallationOctokit"]>>,
  target: { owner: string; repo: string },
  environment: string,
  sha: string,
): Promise<number> {
  const { data } = await octokit.request("POST /repos/{owner}/{repo}/deployments", {
    ...target,
    ref: sha,
    environment,
    description: "ocel preview",
    transient_environment: true,
    auto_merge: false,
    required_contexts: [],
  });
  if (!("id" in data)) throw new Error(`github refused the deployment: ${data.message}`);
  return Number(data.id);
}

function statusFor(deployment: {
  state: DeploymentState;
  logUrl?: string;
  environmentUrl?: string;
}): DeploymentStatus {
  const status: DeploymentStatus = { state: deployment.state };
  if (deployment.logUrl) status.log_url = deployment.logUrl;
  if (deployment.state === "success") {
    if (deployment.environmentUrl) status.environment_url = deployment.environmentUrl;
    status.auto_inactive = true;
  }
  return status;
}
