import { Code, ConnectError } from "@connectrpc/connect";
import { db } from "@console/db";
import { organization, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { addPipeline, type NewPipeline, pipelinesOf } from "@console/git";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admitPipeline, type ReportTier } from "./admit";
import { AUDIENCE, githubActions } from "./testing";

const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`;
let projectId = "";
let other = "";
let gha: Awaited<ReturnType<typeof githubActions>>;
let deps: Parameters<typeof admitPipeline>[2];

async function freshProject(name: string) {
  const id = `${name}-${crypto.randomUUID()}`;
  await db.insert(project).values({ id, organizationId: orgId, name, slug: id });
  return id;
}

function trust(over: Partial<NewPipeline> = {}) {
  return addPipeline({
    projectId,
    repository: "acme/web",
    repositoryId: "1234",
    repositoryOwnerId: "42",
    workflow: null,
    environment: null,
    branches: ["*"],
    origin: "manual",
    createdBy: null,
    ...over,
  });
}

function admit(token: string, tier: ReportTier = "preview", into = projectId) {
  return admitPipeline(token, { projectId: into, tier }, deps);
}

async function refusal(token: string, tier: ReportTier = "preview", into = projectId) {
  const error = await admit(token, tier, into).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConnectError);
  return error as ConnectError;
}

beforeAll(async () => {
  await setupTestDatabase();
  await db
    .insert(organization)
    .values({ id: orgId, name: "A", slug: orgId, createdAt: new Date() });
  gha = await githubActions();
  deps = { keys: createLocalJWKSet(gha.keys), audience: AUDIENCE };
});

beforeEach(async () => {
  projectId = await freshProject("web");
  other = await freshProject("other");
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
});

describe("a token GitHub Actions signed for a trusted pipeline", () => {
  it("is admitted, with the pipeline, the run's claims and its pull request", async () => {
    const trusted = await trust();

    const admitted = await admit(await gha.sign());

    expect(admitted.pipeline.id).toBe(trusted.id);
    expect(admitted.claims).toMatchObject({ repository: "acme/web", actor: "octocat" });
    expect(admitted.pr).toBe(7);
    expect((await pipelinesOf(projectId))[0]?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("is admitted to report production from a push to a branch, with no pull request", async () => {
    await trust({ branches: ["main"] });

    const admitted = await admit(await gha.push("main"), "production");

    expect(admitted.pr).toBeUndefined();
  });

  it("is admitted to report a preview from a run that belongs to no pull request", async () => {
    await trust();

    expect((await admit(await gha.push("feat/y"), "preview")).pr).toBeUndefined();
  });
});

describe("a token that is not GitHub Actions' for this console", () => {
  it.each([
    ["another audience", () => gha.sign({}, { audience: "https://elsewhere.example" })],
    ["another issuer", () => gha.sign({}, { issuer: "https://token.example" })],
    [
      "another key",
      async () => {
        const forger = await githubActions();
        return forger.sign();
      },
    ],
    [
      "an expired one",
      () =>
        new SignJWT({ repository_id: "1234" })
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setIssuer("https://token.actions.githubusercontent.com")
          .setAudience(AUDIENCE)
          .setExpirationTime(Math.floor(Date.now() / 1000) - 600)
          .sign(gha.privateKey),
    ],
    ["one naming no repository", () => gha.sign({ repository_id: undefined })],
  ])("is refused as unauthenticated: %s", async (_, token) => {
    await trust();

    expect((await refusal(await token())).code).toBe(Code.Unauthenticated);
  });

  it("is refused as unauthenticated when it is used a second time", async () => {
    await trust();
    const token = await gha.sign();
    await admit(token);

    const error = await refusal(token);

    expect(error.code).toBe(Code.Unauthenticated);
    expect(error.rawMessage).toMatch(/already/);
  });
});

describe("a token from a run no trusted pipeline of the project covers", () => {
  it("is refused for another repository, naming its id", async () => {
    await trust();

    const error = await refusal(await gha.sign({ repository_id: "999" }));

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain("repository_id 999");
  });

  it("is refused for a repository that changed owners", async () => {
    await trust();

    const error = await refusal(await gha.sign({ repository_owner_id: "7" }));

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain("repository_owner_id 7");
  });

  it("is refused when it reports into a project other than the pipeline's", async () => {
    await trust();

    const error = await refusal(await gha.sign(), "preview", other);

    expect(error.code).toBe(Code.PermissionDenied);
  });

  it("is refused for a pull request run that reports production", async () => {
    await trust();

    const error = await refusal(await gha.sign(), "production");

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain("pull_request");
  });

  it("is refused for a branch none of the pipeline's patterns match, naming them", async () => {
    await trust({ branches: ["main"] });

    const error = await refusal(await gha.sign());

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain(
      "branch feat/x matches none of the pipeline's branches: main",
    );
  });

  it("is refused for a ref that is no branch, such as a tag", async () => {
    await trust();

    const error = await refusal(
      await gha.sign({ event_name: "push", ref: "refs/tags/v1", head_ref: "" }),
      "production",
    );

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain("refs/tags/v1");
  });

  it("is refused for a workflow other than the pipeline's", async () => {
    await trust({ workflow: ".github/workflows/deploy.yml" });

    const error = await refusal(await gha.sign());

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain("workflow .github/workflows/preview.yml");
  });

  it("is refused for a workflow of that path in another repository", async () => {
    await trust({ workflow: ".github/workflows/preview.yml" });

    const error = await refusal(
      await gha.sign({
        job_workflow_ref: "evil/tools/.github/workflows/preview.yml@refs/heads/main",
      }),
    );

    expect(error.code).toBe(Code.PermissionDenied);
  });

  it("is refused for an environment other than the pipeline's", async () => {
    await trust({ environment: "preview" });

    const error = await refusal(await gha.sign({ environment: "staging" }));

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain("environment staging");
  });
});

describe("a pipeline's narrowing", () => {
  it("admits the workflow and environment it names", async () => {
    await trust({ workflow: ".github/workflows/preview.yml", environment: "preview" });

    await expect(admit(await gha.sign({ environment: "preview" }))).resolves.toBeDefined();
  });

  it.each([
    [["*"], "feat/deep/nested", true],
    [["release/*"], "release/1.2", true],
    [["release/*"], "release/a/b", true],
    [["release/*"], "releases/1", false],
    [["release/*"], "main", false],
    [["main"], "main", true],
    [["main"], "main2", false],
    [["feat.x"], "featyx", false],
    [["main", "release/*"], "release/2", true],
  ])("with branches %j, takes %s: %s", async (branches, branch, admitted) => {
    await trust({ branches });

    const outcome = await admit(await gha.push(branch), "production").then(
      () => true,
      () => false,
    );

    expect(outcome).toBe(admitted);
  });
});

describe("a pipeline added for a repository the console could not see", () => {
  it("is pinned to the ids of the first token that names it, then holds to them", async () => {
    await trust({ repository: "Acme/Web", repositoryId: null, repositoryOwnerId: null });

    await admit(await gha.sign());

    expect((await pipelinesOf(projectId))[0]).toMatchObject({
      repositoryId: "1234",
      repositoryOwnerId: "42",
    });
    const error = await refusal(await gha.sign({ repository_id: "555" }));
    expect(error.code).toBe(Code.PermissionDenied);
  });

  it("is not pinned by a token from a repository of another name", async () => {
    await trust({ repository: "acme/private", repositoryId: null, repositoryOwnerId: null });

    const error = await refusal(await gha.sign());

    expect(error.code).toBe(Code.PermissionDenied);
    expect((await pipelinesOf(projectId))[0]?.repositoryId).toBeNull();
  });
});
