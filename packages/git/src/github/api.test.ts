import { describe, expect, it } from "vitest";
import { githubProvider } from "./provider";
import { fakeGithub, PRIVATE_KEY, WEBHOOK_SECRET } from "./test-support";

const installation = { externalId: "99" };
const repo = { id: "1234", fullName: "acme/web" };
const marker = "<!-- ocel-preview -->";

function setup() {
  const github = fakeGithub();
  const provider = githubProvider(
    { appId: "7", privateKey: PRIVATE_KEY, webhookSecret: WEBHOOK_SECRET },
    { fetch: github.fetch },
  );
  return { github, provider };
}

describe("repoToken", () => {
  it("mints a token limited to one repository and read access", async () => {
    const { github, provider } = setup();

    const token = await provider.repoToken(installation, repo, "read");

    expect(token.token).toBe("ghs_installation");
    expect(token.expiresAt).toEqual(new Date("2030-01-01T00:00:00Z"));
    const [mint] = github.callsTo("POST", /access_tokens$/);
    expect(mint?.path).toBe("/app/installations/99/access_tokens");
    expect(mint?.body).toEqual({ repositories: ["web"], permissions: { contents: "read" } });
  });
});

describe("listRepos", () => {
  it("returns every repository the installation reaches, across pages", async () => {
    const { github, provider } = setup();
    for (let id = 1; id <= 150; id++) {
      github.repositories.push({ id, full_name: `acme/repo-${id}` });
    }

    const repos = await provider.listRepos(installation);

    expect(repos).toHaveLength(150);
    expect(repos[0]).toEqual({ id: "1", fullName: "acme/repo-1" });
  });
});

describe("setStatus", () => {
  it("posts a commit status", async () => {
    const { github, provider } = setup();

    await provider.setStatus(installation, repo, {
      sha: "a".repeat(40),
      state: "pending",
      context: "ocel/preview",
      description: "Deploying",
      targetUrl: "https://console.example/run/1",
    });

    const [post] = github.callsTo("POST", /\/statuses\//);
    expect(post?.path).toBe(`/repos/acme/web/statuses/${"a".repeat(40)}`);
    expect(post?.body).toEqual({
      state: "pending",
      context: "ocel/preview",
      description: "Deploying",
      target_url: "https://console.example/run/1",
    });
  });
});

describe("upsertComment", () => {
  it("creates the comment once and updates it afterwards", async () => {
    const { github, provider } = setup();

    await provider.upsertComment(installation, repo, { pr: 7, marker, body: `${marker}\nfirst` });
    await provider.upsertComment(installation, repo, { pr: 7, marker, body: `${marker}\nsecond` });

    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]?.body).toBe(`${marker}\nsecond`);
  });

  it("does not take a person's comment quoting the marker for its own", async () => {
    const { github, provider } = setup();
    github.comments.push({ id: 500, body: `noise ${marker}`, user: { type: "User" } });

    await provider.upsertComment(installation, repo, { pr: 7, marker, body: `${marker}\nmine` });

    expect(github.comments).toHaveLength(2);
    expect(github.comments[0]?.body).toBe(`noise ${marker}`);
  });

  it("finds its comment past the first page", async () => {
    const { github, provider } = setup();
    for (let id = 1; id <= 100; id++) {
      github.comments.push({ id, body: "chatter", user: { type: "User" } });
    }
    github.comments.push({ id: 101, body: `${marker}\nold`, user: { type: "Bot" } });

    await provider.upsertComment(installation, repo, { pr: 7, marker, body: `${marker}\nnew` });

    expect(github.comments).toHaveLength(101);
    expect(github.comments[100]?.body).toBe(`${marker}\nnew`);
  });
});

describe("upsertDeployment", () => {
  const sha = "a".repeat(40);
  const environment = "preview/pr-7";

  it("reuses one deployment per commit and reports each state on it", async () => {
    const { github, provider } = setup();

    await provider.upsertDeployment(installation, repo, {
      environment,
      sha,
      state: "in_progress",
      logUrl: "https://run/1",
    });
    await provider.upsertDeployment(installation, repo, {
      environment,
      sha,
      state: "success",
      logUrl: "https://run/1",
      environmentUrl: "https://web.preview.example",
    });

    expect(github.deployments).toHaveLength(1);
    const statuses = github.callsTo("POST", /deployments\/\d+\/statuses$/);
    expect(statuses.map((call) => call.body)).toEqual([
      { state: "in_progress", log_url: "https://run/1" },
      {
        state: "success",
        log_url: "https://run/1",
        environment_url: "https://web.preview.example",
        auto_inactive: true,
      },
    ]);
    const [created] = github.callsTo("POST", /\/deployments$/);
    expect(created?.body).toMatchObject({
      ref: sha,
      environment,
      transient_environment: true,
      auto_merge: false,
      required_contexts: [],
    });
  });

  it("opens a new deployment for a new commit", async () => {
    const { github, provider } = setup();

    await provider.upsertDeployment(installation, repo, { environment, sha, state: "in_progress" });
    await provider.upsertDeployment(installation, repo, {
      environment,
      sha: "b".repeat(40),
      state: "in_progress",
    });

    expect(github.deployments).toHaveLength(2);
  });

  it("inactivates every deployment of the environment when no commit is named", async () => {
    const { github, provider } = setup();
    await provider.upsertDeployment(installation, repo, { environment, sha, state: "in_progress" });
    await provider.upsertDeployment(installation, repo, {
      environment,
      sha: "b".repeat(40),
      state: "in_progress",
    });

    await provider.upsertDeployment(installation, repo, { environment, state: "inactive" });

    const inactive = github.callsTo("POST", /deployments\/\d+\/statuses$/).slice(-2);
    const [first, second] = github.deployments;
    expect(inactive.map((call) => [call.path, call.body])).toEqual([
      [`/repos/acme/web/deployments/${first?.id}/statuses`, { state: "inactive" }],
      [`/repos/acme/web/deployments/${second?.id}/statuses`, { state: "inactive" }],
    ]);
    expect(github.deployments).toHaveLength(2);
  });

  it("refuses to open a deployment without a commit to deploy", async () => {
    const { provider } = setup();
    await expect(
      provider.upsertDeployment(installation, repo, { environment, state: "success" }),
    ).rejects.toThrow(/commit/);
  });
});
