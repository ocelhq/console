import { createHmac, timingSafeEqual } from "node:crypto";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import type {
  DeploymentState,
  GitProvider,
  InstallationRef,
  RepoRef,
  UserInstallation,
} from "../provider";
import type { AppSecret } from "../store";
import { parseGithubEvent } from "./events";

export interface GithubApp {
  appId: string;
  slug: string;
  clientId: string;
  secret(name: AppSecret): Promise<string>;
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

function ownerAndName(repo: RepoRef): { owner: string; repo: string } {
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

function signatureMatches(body: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    "utf8",
  );
  const given = Buffer.from(signature, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function githubProvider(github: GithubApp, options: GithubOptions = {}): GitProvider {
  const BaseOctokit = options.fetch
    ? Octokit.defaults({ request: { fetch: options.fetch } })
    : Octokit;
  let authenticated: Promise<App> | undefined;
  const app = () => {
    authenticated ??= github
      .secret("privateKey")
      .then((privateKey) => new App({ appId: github.appId, privateKey, Octokit: BaseOctokit }));
    return authenticated;
  };

  const installationClient = async (installation: InstallationRef) =>
    (await app()).getInstallationOctokit(Number(installation.externalId));

  async function deploymentsOf(
    octokit: Awaited<ReturnType<typeof installationClient>>,
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
      return signatureMatches(body, signature, await github.secret("webhookSecret"));
    },

    deliveryId: ({ headers }) => headers.get("x-github-delivery") ?? undefined,

    parseEvent: parseGithubEvent,

    authorizeUrl({ state, redirectUri }) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", github.clientId);
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", redirectUri);
      return url.href;
    },

    async administeredInstallations({ code, redirectUri }) {
      const clientSecret = await github.secret("clientSecret");
      const token = await exchangeCode(options.fetch ?? fetch, {
        client_id: github.clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      });
      try {
        const person = new BaseOctokit({ auth: token });
        const { data: me } = await person.request("GET /user");
        const administers = async (account: {
          id: number | bigint;
          login: string;
          type: string;
        }) => {
          if (account.type === "User") return String(account.id) === String(me.id);
          if (account.type !== "Organization") return false;
          const membership = await person
            .request("GET /user/memberships/orgs/{org}", { org: account.login })
            .catch(() => undefined);
          return membership?.data.state === "active" && membership.data.role === "admin";
        };
        const installations = await everyPage(async (page) => {
          const { data } = await person.request("GET /user/installations", {
            per_page: PAGE,
            page,
          });
          return data.installations;
        });
        const administered: UserInstallation[] = [];
        for (const installation of installations) {
          const account = installation.account;
          if (!account || !("login" in account) || !(await administers(account))) continue;
          administered.push({ externalId: String(installation.id), account: account.login });
        }
        return administered;
      } finally {
        await new BaseOctokit()
          .request("DELETE /applications/{client_id}/token", {
            client_id: github.clientId,
            access_token: token,
            headers: {
              authorization: `basic ${Buffer.from(`${github.clientId}:${clientSecret}`).toString("base64")}`,
            },
          })
          .catch(() => undefined);
      }
    },

    async listRepos(installation) {
      const octokit = await installationClient(installation);
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
      const { data } = await (await app()).octokit.request(
        "POST /app/installations/{installation_id}/access_tokens",
        {
          installation_id: Number(installation.externalId),
          repository_ids: [Number(repo.id)],
          permissions: { contents: access },
        },
      );
      return { token: data.token, expiresAt: new Date(data.expires_at) };
    },

    async setStatus(installation, repo, status) {
      const octokit = await installationClient(installation);
      await octokit.request("POST /repos/{owner}/{repo}/statuses/{sha}", {
        ...ownerAndName(repo),
        sha: status.sha,
        state: status.state,
        context: status.context,
        description: status.description,
        target_url: status.targetUrl,
      });
    },

    async upsertComment(installation, repo, { pr, marker, body }) {
      const octokit = await installationClient(installation);
      const target = ownerAndName(repo);
      const comments = await everyPage(async (page) => {
        const { data } = await octokit.request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
          { ...target, issue_number: pr, per_page: PAGE, page },
        );
        return data;
      });
      const sticky = comments.find(
        (comment) =>
          comment.user?.login === `${github.slug}[bot]` && comment.body?.includes(marker),
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
      const octokit = await installationClient(installation);
      const target = ownerAndName(repo);
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

async function exchangeCode(
  fetchImpl: typeof fetch,
  body: { client_id: string; client_secret: string; code: string; redirect_uri: string },
): Promise<string> {
  const response = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = (await response.json()) as { access_token?: string; error?: string };
  if (!response.ok || !answer.access_token) {
    throw new Error(`github refused the authorization code: ${answer.error ?? response.status}`);
  }
  return answer.access_token;
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
