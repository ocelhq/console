import { generateKeyPairSync } from "node:crypto";
import { db } from "@console/db";
import { credentialIssuance, project, targetBinding, targetTier } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { addPipeline, pipelinesOf } from "@console/git";
import { prepareTarget, recordTier } from "@console/targets";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestSessionWithOrganization, createTestSessionWithRole } from "@/test/auth-harness";
import { bindProjectTier, grantPipelineCredentials } from "../projects/[slug]/targets/actions";
import { testConnection } from "./actions";

const caller = vi.hoisted(() => ({ headers: new Headers() }));

vi.hoisted(() => {
  process.env.CONSOLE_ISSUER_KEY = (require("node:crypto") as typeof import("node:crypto"))
    .generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
});

vi.mock("next/headers", () => ({ headers: async () => caller.headers }));

let owner: Awaited<ReturnType<typeof createTestSessionWithOrganization>>;
let member: Awaited<ReturnType<typeof createTestSessionWithRole>>;
let stranger: Awaited<ReturnType<typeof createTestSessionWithOrganization>>;
let projectId = "";
let targetId = "";
let strangersTarget = "";
const exchanged: { url: string; body: URLSearchParams }[] = [];

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
}

const identity = {
  identityProvider: "arn:aws:iam::123456789012:oidc-provider/localhost:3000/oidc",
  principal: "arn:aws:iam::123456789012:role/ocel-deploy-production",
};

function as(session: { headers: Headers }) {
  caller.headers = session.headers;
}

async function targetIn(organizationId: string) {
  const target = await prepareTarget(organizationId, {
    vendor: "aws",
    account: "123456789012",
    region: "eu-west-1",
  });
  await recordTier(db, {
    targetId: target.id,
    tier: "production",
    identity,
    cliVersion: "0.0.3",
  });
  return target.id;
}

beforeAll(async () => {
  vi.stubEnv(
    "CONSOLE_ISSUER_KEY",
    generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString(),
  );
  await setupTestDatabase();
  owner = await createTestSessionWithOrganization();
  stranger = await createTestSessionWithOrganization();
  member = await createTestSessionWithRole(owner.organization.id, "member");
  targetId = await targetIn(owner.organization.id);
  strangersTarget = await targetIn(stranger.organization.id);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    exchanged.push({ url, body: new URLSearchParams(String(init.body)) });
    return new Response(
      "<AssumeRoleWithWebIdentityResponse><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/ocel-deploy-production/s</Arn></AssumedRoleUser></AssumeRoleWithWebIdentityResponse>",
    );
  });
});

beforeEach(async () => {
  projectId = crypto.randomUUID();
  await db
    .insert(project)
    .values({ id: projectId, organizationId: owner.organization.id, name: "w", slug: projectId });
  as(owner);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await member.cleanup();
  await owner.cleanup();
  await stranger.cleanup();
});

describe("testConnection", () => {
  it("exchanges a test token for the reserved project and logs it as a test", async () => {
    const answer = await testConnection(targetId, "production");

    expect(answer).toEqual({
      ok: true,
      result: "assumed arn:aws:sts::123456789012:assumed-role/ocel-deploy-production/s",
    });
    const token = exchanged.at(-1)?.body.get("WebIdentityToken") ?? "";
    expect(decodeJwt(token)).toMatchObject({ project: "connection-test", purpose: "test" });
    const [logged] = await db
      .select()
      .from(credentialIssuance)
      .where(eq(credentialIssuance.tokenJti, String(decodeJwt(token).jti)));
    expect(logged).toMatchObject({
      purpose: "test",
      projectId: null,
      principal: { kind: "session", userId: owner.user.id },
    });
    const [tier] = await db.select().from(targetTier).where(eq(targetTier.targetId, targetId));
    expect(tier?.lastIssuedAt).toBeNull();
  });

  it.each([
    ["a member", () => as(member), targetId, "production", /owners and admins/],
    [
      "another organization's target",
      () => {},
      () => strangersTarget,
      "production",
      /isn’t this organization’s/,
    ],
    ["a tier that is neither", () => {}, targetId, "Production", /production or preview/],
  ] as const)("is refused for %s", async (_, who, target, tier, problem) => {
    who();
    const before = exchanged.length;

    const answer = await testConnection(typeof target === "function" ? target() : target, tier);

    expect(answer).toEqual({ ok: false, message: expect.stringMatching(problem) });
    expect(exchanged).toHaveLength(before);
  });
});

describe("bindProjectTier", () => {
  it("binds a project's tier to one of the organization's targets, and unbinds it", async () => {
    expect(await bindProjectTier(projectId, "production", targetId)).toEqual({
      ok: true,
      result: null,
    });
    const bound = () =>
      db.select().from(targetBinding).where(eq(targetBinding.projectId, projectId));
    expect(await bound()).toMatchObject([{ tier: "production", targetId }]);

    await bindProjectTier(projectId, "production", "");

    expect(await bound()).toEqual([]);
  });

  it("refuses another organization's target, another organization's project, a member and a made-up tier", async () => {
    const theirs = crypto.randomUUID();
    await db.insert(project).values({
      id: theirs,
      organizationId: stranger.organization.id,
      name: "t",
      slug: theirs,
    });

    expect((await bindProjectTier(projectId, "production", strangersTarget)).ok).toBe(false);
    expect((await bindProjectTier(theirs, "production", targetId)).ok).toBe(false);
    expect((await bindProjectTier(projectId, "staging", targetId)).ok).toBe(false);
    as(member);
    expect((await bindProjectTier(projectId, "production", targetId)).ok).toBe(false);
    expect(
      await db.select().from(targetBinding).where(eq(targetBinding.projectId, projectId)),
    ).toEqual([]);
  });
});

describe("grantPipelineCredentials", () => {
  const input = {
    production: { enabled: true, branches: "main", environment: "production" },
    preview: { enabled: true, branches: "feat/*" },
  };

  async function pipeline() {
    return addPipeline({
      projectId,
      repository: "acme/web",
      repositoryId: "1",
      repositoryOwnerId: "2",
      workflow: null,
      environment: null,
      branches: ["*"],
      origin: "manual",
      createdBy: null,
    });
  }

  it("stores the grant an admin gives", async () => {
    const added = await pipeline();

    expect((await grantPipelineCredentials(projectId, added.id, input)).ok).toBe(true);

    expect((await pipelinesOf(projectId))[0]?.credentials).toEqual({
      production: { branches: ["main"], environment: "production" },
      preview: { branches: ["feat/*"] },
    });
  });

  it("refuses a member, another organization's project and production for no branch", async () => {
    const added = await pipeline();

    expect(
      await grantPipelineCredentials(projectId, added.id, {
        ...input,
        production: { enabled: true, branches: ", ,", environment: "" },
      }),
    ).toMatchObject({ ok: false });
    as(stranger);
    expect((await grantPipelineCredentials(projectId, added.id, input)).ok).toBe(false);
    as(member);
    expect((await grantPipelineCredentials(projectId, added.id, input)).ok).toBe(false);
    expect((await pipelinesOf(projectId))[0]?.credentials).toEqual({});
  });
});
