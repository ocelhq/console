import { describe, expect, it } from "vitest";
import { githubProvider } from "./provider";
import { fakeGithub, testApp } from "./test-support";

const installation = { externalId: "99" };
const repo = { id: "1234", fullName: "acme/web" };
const marker = "<!-- ocel-preview -->";

function setup() {
  const github = fakeGithub();
  const provider = githubProvider(testApp(), { fetch: github.fetch });
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
    expect(mint?.body).toEqual({ repository_ids: [1234], permissions: { contents: "read" } });
  });

  it("names the repository by id, so a renamed repository still gets its token", async () => {
    const { github, provider } = setup();

    await provider.repoToken(installation, { id: "1234", fullName: "acme/old-name" }, "read");

    const [mint] = github.callsTo("POST", /access_tokens$/);
    expect(mint?.body).toMatchObject({ repository_ids: [1234] });
    expect(mint?.body).not.toHaveProperty("repositories");
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
    github.comments.push({
      id: 500,
      body: `noise ${marker}`,
      user: { login: "someone", type: "User" },
    });

    await provider.upsertComment(installation, repo, { pr: 7, marker, body: `${marker}\nmine` });

    expect(github.comments).toHaveLength(2);
    expect(github.comments[0]?.body).toBe(`noise ${marker}`);
  });

  it("does not take another app's comment carrying the same marker for its own", async () => {
    const { github, provider } = setup();
    github.comments.push({
      id: 500,
      body: `${marker}\ntheirs`,
      user: { login: "other-ocel[bot]", type: "Bot" },
    });

    await provider.upsertComment(installation, repo, { pr: 7, marker, body: `${marker}\nmine` });

    expect(github.comments.map((comment) => comment.body)).toEqual([
      `${marker}\ntheirs`,
      `${marker}\nmine`,
    ]);
    expect(github.callsTo("PATCH", /comments/)).toEqual([]);
  });

  it("finds its comment past the first page", async () => {
    const { github, provider } = setup();
    for (let id = 1; id <= 100; id++) {
      github.comments.push({ id, body: "chatter", user: { login: "someone", type: "User" } });
    }
    github.comments.push({
      id: 101,
      body: `${marker}\nold`,
      user: { login: "ocel-test[bot]", type: "Bot" },
    });

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

describe("authorizeUrl", () => {
  it("sends the person to authorize the app, carrying the state and where to come back", () => {
    const { provider } = setup();
    const url = new URL(
      provider.authorizeUrl({ state: "s.t", redirectUri: "https://console.example/back" }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "Iv1.test",
      state: "s.t",
      redirect_uri: "https://console.example/back",
    });
  });
});

describe("administeredInstallations", () => {
  const redirectUri = "https://console.example/back";
  const person = { id: 42, login: "ada" };

  it("lists every installation on an account the person administers, then revokes their token", async () => {
    const { github, provider } = setup();
    github.oauth.codes.set("code-1", "ghu_person");
    github.oauth.people.set("ghu_person", { ...person, roles: {} });
    github.oauth.userInstallations.set(
      "ghu_person",
      Array.from({ length: 101 }, (_, index) => ({
        id: index + 1,
        account: { id: person.id, login: person.login, type: "User" as const },
      })),
    );

    const installations = await provider.administeredInstallations({ code: "code-1", redirectUri });

    expect(installations).toHaveLength(101);
    expect(installations[100]).toEqual({ externalId: "101", account: "ada" });
    const [exchange] = github.callsTo("POST", /^\/login\/oauth\/access_token$/);
    expect(exchange?.body).toEqual({
      client_id: "Iv1.test",
      client_secret: "client-secret",
      code: "code-1",
      redirect_uri: redirectUri,
    });
    expect(github.oauth.revoked).toEqual(["ghu_person"]);
  });

  it("leaves out installations the person reaches only as a collaborator or member", async () => {
    const { github, provider } = setup();
    github.oauth.codes.set("code-1", "ghu_person");
    github.oauth.people.set("ghu_person", {
      ...person,
      roles: { "acme-admin": "admin", "acme-member": "member" },
    });
    github.oauth.userInstallations.set("ghu_person", [
      { id: 1, account: { id: 42, login: "ada", type: "User" } },
      { id: 2, account: { id: 43, login: "grace", type: "User" } },
      { id: 3, account: { id: 100, login: "acme-admin", type: "Organization" } },
      { id: 4, account: { id: 101, login: "acme-member", type: "Organization" } },
      { id: 5, account: { id: 102, login: "acme-outside", type: "Organization" } },
    ]);

    const installations = await provider.administeredInstallations({ code: "code-1", redirectUri });

    expect(installations).toEqual([
      { externalId: "1", account: "ada" },
      { externalId: "3", account: "acme-admin" },
    ]);
    expect(github.oauth.revoked).toEqual(["ghu_person"]);
  });

  it("fails when GitHub refuses the code", async () => {
    const { provider } = setup();
    await expect(
      provider.administeredInstallations({ code: "stale", redirectUri }),
    ).rejects.toThrow(/bad_verification_code/);
  });
});
