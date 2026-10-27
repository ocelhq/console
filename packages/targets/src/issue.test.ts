import { generateKeyPairSync } from "node:crypto";
import { db } from "@console/db";
import { credentialIssuance, organization, project, targetTier } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issue } from "./issue";
import { createIssuer } from "./issuer";
import { keySigner } from "./key";
import { prepareTarget, recordTier } from "./store";

const orgId = `org-${crypto.randomUUID()}`;
const projectId = crypto.randomUUID();
const issuer = createIssuer("https://console.example.com", {
  signer: keySigner(
    generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString(),
  ),
  previous: [],
});

async function verified(token: string, targetId: string) {
  const { payload } = await jwtVerify(token, createLocalJWKSet(await issuer.jwks()), {
    issuer: "https://console.example.com/oidc",
    audience: `ocel-target:${targetId}`,
    algorithms: ["ES256"],
  });
  return payload;
}

async function tierRow(targetId: string) {
  const [row] = await db.select().from(targetTier).where(eq(targetTier.targetId, targetId));
  return row;
}

async function logged(jti: string) {
  const [row] = await db
    .select()
    .from(credentialIssuance)
    .where(eq(credentialIssuance.tokenJti, jti));
  return row;
}

beforeAll(async () => {
  await setupTestDatabase();
  await db
    .insert(organization)
    .values({ id: orgId, name: "A", slug: orgId, createdAt: new Date() });
  await db.insert(project).values({ id: projectId, organizationId: orgId, name: "w", slug: "w" });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
});

async function target(region: string) {
  const prepared = await prepareTarget(orgId, { vendor: "aws", account: "123456789012", region });
  await recordTier(db, {
    targetId: prepared.id,
    tier: "production",
    identity: {
      identityProvider: "arn:aws:iam::123456789012:oidc-provider/console.example.com/oidc",
      principal: "arn:aws:iam::123456789012:role/ocel-deploy-production",
    },
    grants: ["s3:putobject arn:aws:s3:::ocel-*"],
    cliVersion: "0.0.3",
  });
  return prepared;
}

describe("issuing a deploy credential", () => {
  it("mints a token pinned to the project, logs it and notes when the tier last issued", async () => {
    const prepared = await target("eu-west-1");

    const issued = await issue(db, issuer, {
      target: prepared,
      tier: "production",
      lifetimeSeconds: 600,
      purpose: "deploy",
      projectId,
      principal: { kind: "pipeline", pipelineId: "p", jti: "gha", runUrl: "https://run" },
    });

    const payload = await verified(issued.token, prepared.id);
    expect(payload).toMatchObject({
      sub: `org:${orgId}:target:${prepared.id}:tier:production:project:${projectId}`,
      project: projectId,
      purpose: "deploy",
      jti: issued.jti,
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(600);
    expect(await logged(issued.jti)).toMatchObject({ projectId, purpose: "deploy" });
    expect((await tierRow(prepared.id))?.lastIssuedAt).toBeInstanceOf(Date);
  });
});

describe("issuing a connection test", () => {
  it("names the reserved test project, logs it as a test and leaves the tier's last issue alone", async () => {
    const prepared = await target("eu-west-2");

    const issued = await issue(db, issuer, {
      target: prepared,
      tier: "production",
      lifetimeSeconds: 60,
      purpose: "test",
      principal: { kind: "session", userId: "u" },
    });

    expect(await verified(issued.token, prepared.id)).toMatchObject({
      sub: `org:${orgId}:target:${prepared.id}:tier:production:project:connection-test`,
      project: "connection-test",
      purpose: "test",
    });
    expect(await logged(issued.jti)).toMatchObject({
      projectId: null,
      purpose: "test",
      principal: { kind: "session", userId: "u" },
    });
    expect((await tierRow(prepared.id))?.lastIssuedAt).toBeNull();
  });

  it("logs nothing when the transaction it ran in is rolled back", async () => {
    const prepared = await target("eu-west-3");
    let jti = "";

    await db
      .transaction(async (tx) => {
        jti = (
          await issue(tx, issuer, {
            target: prepared,
            tier: "production",
            lifetimeSeconds: 60,
            purpose: "test",
            principal: { kind: "session", userId: "u" },
          })
        ).jti;
        throw new Error("rolled back");
      })
      .catch(() => undefined);

    expect(await logged(jti)).toBeUndefined();
  });
});
