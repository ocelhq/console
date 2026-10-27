import { Code, ConnectError } from "@connectrpc/connect";
import { db } from "@console/db";
import { type CredentialGrant, organization, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { addPipeline, claimPipeline, type NewPipeline, pipelinesOf } from "@console/git";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admitCredential, admitPipeline, claimAdmission, type ReportTier } from "./admit";
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

async function admit(token: string, tier: ReportTier = "preview", into = projectId) {
  const admitted = await admitPipeline(token, { projectId: into, tier }, deps);
  await db.transaction((tx) => claimAdmission(tx, admitted));
  return admitted;
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
    ["one whose head_ref is no string", () => gha.sign({ head_ref: 7 })],
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

describe("a token admitted but never claimed", () => {
  it("can still be claimed, so a refused report does not spend it", async () => {
    await trust();
    const token = await gha.sign();
    await admitPipeline(token, { projectId, tier: "preview" }, deps);

    await expect(admit(token)).resolves.toBeDefined();
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

  it("refuses a token admitted while another repository's token pinned the pipeline", async () => {
    const pending = await trust({
      repository: "acme/web",
      repositoryId: null,
      repositoryOwnerId: null,
    });
    const admitted = await admitPipeline(await gha.sign(), { projectId, tier: "preview" }, deps);
    await claimPipeline(db, pending.id, { repositoryId: "555", repositoryOwnerId: "42" });

    const error = await db
      .transaction((tx) => claimAdmission(tx, admitted))
      .catch((thrown: unknown) => thrown);

    expect(ConnectError.from(error).code).toBe(Code.PermissionDenied);
  });

  it("is not pinned by a token from a repository of another name", async () => {
    await trust({ repository: "acme/private", repositoryId: null, repositoryOwnerId: null });

    const error = await refusal(await gha.sign());

    expect(error.code).toBe(Code.PermissionDenied);
    expect((await pipelinesOf(projectId))[0]?.repositoryId).toBeNull();
  });
});

async function credential(token: string, tier: ReportTier, into = projectId) {
  const admitted = await admitCredential(token, { projectId: into, tier }, deps);
  await db.transaction((tx) => claimAdmission(tx, admitted));
  return admitted;
}

async function credentialRefusal(token: string, tier: ReportTier) {
  const error = await credential(token, tier).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConnectError);
  return error as ConnectError;
}

describe("a token asking for credentials", () => {
  const granted = {
    production: { branches: ["main"] },
    preview: { branches: ["feat/*"] },
  };

  it("is admitted for production from a push to a granted branch", async () => {
    await trust({ credentials: granted });

    await expect(credential(await gha.push("main"), "production")).resolves.toBeDefined();
  });

  it("is admitted for a preview from a pull request whose head branch is granted", async () => {
    await trust({ credentials: granted });

    expect((await credential(await gha.sign(), "preview")).pr).toBe(7);
  });

  it("is gated by the credential grant, not the branches the pipeline may report from", async () => {
    await trust({ branches: ["*"], credentials: granted });

    await expect(admit(await gha.push("release/1"), "production")).resolves.toBeDefined();
    const error = await credentialRefusal(await gha.push("release/2"), "production");

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain(
      "This run may not get credentials for the project: branch release/2 matches none of the pipeline's production credential branches: main",
    );
  });

  it("still holds the run to the pipeline's repository", async () => {
    await trust({ credentials: granted });

    const error = await credentialRefusal(
      await gha.push("main", { repository_id: "999" }),
      "production",
    );

    expect(error.rawMessage).toContain("repository_id 999");
  });

  it.each<[string, CredentialGrant, () => Promise<string>, ReportTier, RegExp]>([
    [
      "a pipeline granted nothing",
      {},
      () => gha.push("main"),
      "production",
      /no production credential grant/,
    ],
    [
      "a pull request run asking for production",
      { production: { branches: ["*"] } },
      () => gha.sign(),
      "production",
      /pull_request run gets no production credentials/,
    ],
    [
      "a pull_request_target run asking for a preview",
      { preview: { branches: ["*"] } },
      () => gha.sign({ event_name: "pull_request_target" }),
      "preview",
      /pull_request_target run gets no preview credentials/,
    ],
    ...(["production", "preview"] as const).flatMap((tier) =>
      (["workflow_run", "issue_comment", "schedule"] as const).map(
        (event): [string, CredentialGrant, () => Promise<string>, ReportTier, RegExp] => [
          `a ${event} run on refs/heads/main asking for ${tier}`,
          { production: { branches: ["*"] }, preview: { branches: ["*"] } },
          () => gha.push("main", { event_name: event }),
          tier,
          new RegExp(`a ${event} run gets no ${tier} credentials`),
        ],
      ),
    ),

    [
      "a preview from a pipeline granted only production",
      { production: { branches: ["*"] } },
      () => gha.sign(),
      "preview",
      /no preview credential grant/,
    ],
    [
      "a production run outside the environment the grant names",
      { production: { branches: ["main"], environment: "production" } },
      () => gha.push("main", { environment: "staging" }),
      "production",
      /environment staging is not the one the production credential grant names: production/,
    ],
  ])("is refused for %s", async (_, credentials, token, tier, problem) => {
    await trust({ credentials, branches: ["main", "release/*", "feat/*"] });

    const error = await credentialRefusal(await token(), tier);

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toMatch(problem);
  });

  it("is refused on a branch the pipeline itself does not take, whatever the grant says", async () => {
    await trust({ branches: ["release/*"], credentials: { preview: { branches: ["*"] } } });

    const error = await credentialRefusal(await gha.push("feature/x"), "preview");

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain(
      "branch feature/x matches none of the pipeline's branches: release/*",
    );
  });

  it("is admitted for production from a workflow_dispatch run on a granted branch", async () => {
    await trust({ credentials: granted });

    await expect(
      credential(await gha.push("main", { event_name: "workflow_dispatch" }), "production"),
    ).resolves.toBeDefined();
  });

  it("is admitted for a preview from a push to a granted branch", async () => {
    await trust({ credentials: granted });

    await expect(credential(await gha.push("feat/y"), "preview")).resolves.toBeDefined();
  });

  it("is admitted for production in the environment the grant names", async () => {
    await trust({ credentials: { production: { branches: ["main"], environment: "production" } } });

    await expect(
      credential(await gha.push("main", { environment: "production" }), "production"),
    ).resolves.toBeDefined();
  });

  it("is spent like a report's, so it is refused a second time", async () => {
    await trust({ credentials: granted });
    const token = await gha.push("main");
    await credential(token, "production");

    expect((await credentialRefusal(token, "production")).code).toBe(Code.Unauthenticated);
  });
});
