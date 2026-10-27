import { db } from "@console/db";
import { credentialIssuance, organization, project, targetBinding } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bindProject,
  boundTarget,
  issuancesOf,
  prepareTarget,
  recordIssuance,
  recordTier,
  removeTarget,
  targetOf,
  targetsOf,
  unbindProject,
} from "./store";

const orgId = `org-${crypto.randomUUID()}`;
const otherOrg = `org-${crypto.randomUUID()}`;
const projectId = crypto.randomUUID();
const identity = {
  identityProvider: "arn:aws:iam::123456789012:oidc-provider/console.example.com/oidc",
  principal: "arn:aws:iam::123456789012:role/ocel-deploy-production",
};

function place(region = "eu-west-1") {
  return { vendor: "aws", account: "123456789012", region };
}

beforeAll(async () => {
  await setupTestDatabase();
  await db.insert(organization).values([
    { id: orgId, name: "A", slug: orgId, createdAt: new Date() },
    { id: otherOrg, name: "B", slug: otherOrg, createdAt: new Date() },
  ]);
  await db.insert(project).values({ id: projectId, organizationId: orgId, name: "w", slug: "w" });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
  await db.delete(organization).where(eq(organization.id, otherOrg));
});

describe("a target", () => {
  it("is found again for the same vendor, account and region, and is the organization's alone", async () => {
    const first = await prepareTarget(orgId, place());

    expect(await prepareTarget(orgId, place())).toEqual(first);
    expect((await prepareTarget(otherOrg, place())).id).not.toBe(first.id);
    expect((await prepareTarget(orgId, place("us-east-1"))).id).not.toBe(first.id);
    expect(await targetOf(otherOrg, first.id)).toBeUndefined();
  });

  it("records each tier's identity again over the last, keeping when it last issued", async () => {
    const prepared = await prepareTarget(orgId, place("eu-central-1"));
    const recorded = { targetId: prepared.id, tier: "production" as const, identity };
    await recordTier(db, { ...recorded, grants: ["s3:putobject *"], cliVersion: "0.0.3" });
    await recordIssuance(db, {
      organizationId: orgId,
      projectId,
      targetId: prepared.id,
      tier: "production",
      principal: { kind: "session", userId: "u" },
      tokenJti: crypto.randomUUID(),
      issuedAt: new Date("2026-10-01T00:00:00Z"),
      expiresAt: new Date("2026-10-01T00:10:00Z"),
    });

    await recordTier(db, { ...recorded, grants: ["s3:getobject *"], cliVersion: "0.0.4" });

    const [found] = (await targetsOf(orgId)).filter((kept) => kept.id === prepared.id);
    expect(found?.tiers).toMatchObject([
      {
        tier: "production",
        principal: identity.principal,
        grants: ["s3:getobject *"],
        cliVersion: "0.0.4",
        lastIssuedAt: new Date("2026-10-01T00:00:00Z"),
      },
    ]);
  });
});

describe("a project tier's binding", () => {
  it("names one target, replaced by the next, with that target's tier", async () => {
    const first = await prepareTarget(orgId, place("ap-south-1"));
    const second = await prepareTarget(orgId, place("ap-south-2"));
    await recordTier(db, {
      targetId: second.id,
      tier: "preview",
      identity,
      grants: ["*"],
      cliVersion: "0.0.3",
    });

    await bindProject(db, { projectId, tier: "preview", targetId: first.id });
    expect(await boundTarget(projectId, "preview")).toMatchObject({
      target: { id: first.id },
      tier: null,
    });
    await bindProject(db, { projectId, tier: "preview", targetId: second.id });
    expect(await boundTarget(projectId, "preview")).toMatchObject({
      target: { id: second.id },
      tier: { principal: identity.principal },
    });

    await unbindProject(projectId, "preview");
    expect(await boundTarget(projectId, "preview")).toBeUndefined();
  });
});

describe("removing a target", () => {
  it("drops its tiers and bindings but keeps what it issued in the log", async () => {
    const removed = await prepareTarget(orgId, place("sa-east-1"));
    await recordTier(db, {
      targetId: removed.id,
      tier: "production",
      identity,
      grants: ["*"],
      cliVersion: "0.0.3",
    });
    await bindProject(db, { projectId, tier: "production", targetId: removed.id });
    const jti = crypto.randomUUID();
    await recordIssuance(db, {
      organizationId: orgId,
      projectId,
      targetId: removed.id,
      tier: "production",
      principal: { kind: "pipeline", pipelineId: "p", jti: "gha", runUrl: "https://run" },
      tokenJti: jti,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    });

    expect(await removeTarget(otherOrg, removed.id)).toBe(false);
    expect(await removeTarget(orgId, removed.id)).toBe(true);

    expect(await targetOf(orgId, removed.id)).toBeUndefined();
    expect(
      await db.select().from(targetBinding).where(eq(targetBinding.targetId, removed.id)),
    ).toEqual([]);
    expect(
      await db.select().from(credentialIssuance).where(eq(credentialIssuance.tokenJti, jti)),
    ).toHaveLength(1);
    const [logged] = (await issuancesOf({ organizationId: orgId, projectId })).filter(
      (row) => row.tokenJti === jti,
    );
    expect(logged).toMatchObject({ projectSlug: "w", vendor: null });
    expect(await issuancesOf({ organizationId: otherOrg })).toEqual([]);
  });
});
