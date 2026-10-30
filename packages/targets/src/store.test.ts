import { generateKeyPairSync } from "node:crypto";
import { db } from "@console/db";
import {
  credentialIssuance,
  organization,
  project,
  target,
  targetBinding,
  targetTier,
} from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issue } from "./issue";
import { createIssuer } from "./issuer";
import { keySigner } from "./key";
import {
  bindProject,
  boundTarget,
  forgetTier,
  issuancesOf,
  prepareTarget,
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

const issuer = createIssuer("https://console.example.com", {
  signer: keySigner(
    generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString(),
  ),
  previous: [],
});

function place(region = "eu-west-1", namespace = "ocel") {
  return { vendor: "aws" as const, account: "123456789012", region, namespace };
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
    await recordTier(db, { ...recorded, cliVersion: "0.0.3" });
    await issue(db, issuer, {
      target: prepared,
      tier: "production",
      lifetimeSeconds: 600,
      purpose: "deploy",
      projectId,
      principal: { kind: "pipeline", pipelineId: "p", jti: "gha", runUrl: "https://run" },
    });
    const [issued] = await db.select().from(targetTier).where(eq(targetTier.targetId, prepared.id));

    await recordTier(db, { ...recorded, cliVersion: "0.0.4" });

    const [found] = (await targetsOf(orgId)).filter((kept) => kept.id === prepared.id);
    expect(found?.tiers).toMatchObject([
      {
        tier: "production",
        principal: identity.principal,
        cliVersion: "0.0.4",
        lastIssuedAt: issued?.lastIssuedAt,
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

describe("forgetting a tier", () => {
  it("drops the tier's identity, leaves its bindings, and is done when there is nothing left", async () => {
    const prepared = await prepareTarget(orgId, place("ca-central-1"));
    await recordTier(db, {
      targetId: prepared.id,
      tier: "production",
      identity,
      cliVersion: "0.0.3",
    });
    await bindProject(db, { projectId, tier: "production", targetId: prepared.id });

    await forgetTier(prepared.id, "production");
    await forgetTier(prepared.id, "production");

    expect(await boundTarget(projectId, "production")).toMatchObject({
      target: { id: prepared.id },
      tier: null,
    });
    await unbindProject(projectId, "production");
  });

  it("remembers that a tier was forgotten, which a target that never recorded one has not", async () => {
    const never = await prepareTarget(orgId, place("eu-north-1"));
    const forgotten = await prepareTarget(orgId, place("eu-south-1"));
    await recordTier(db, {
      targetId: forgotten.id,
      tier: "preview",
      identity,
      cliVersion: "0.0.3",
    });

    await forgetTier(forgotten.id, "preview");
    await forgetTier(never.id, "preview");

    const [listedNever, listedForgotten] = (await targetsOf(orgId)).filter((found) =>
      [never.id, forgotten.id].includes(found.id),
    );
    expect(listedNever?.tierForgottenAt).toBeNull();
    expect(listedForgotten?.tierForgottenAt).toBeInstanceOf(Date);
  });
});

describe("a target's namespace", () => {
  it("makes two namespaces in one account and region two targets", async () => {
    const ocel = await prepareTarget(orgId, place("us-west-1", "ocel"));
    const staging = await prepareTarget(orgId, place("us-west-1", "staging"));
    const again = await prepareTarget(orgId, place("us-west-1", "staging"));

    expect(staging.id).not.toBe(ocel.id);
    expect(again.id).toBe(staging.id);
    expect([ocel.namespace, staging.namespace]).toEqual(["ocel", "staging"]);
  });

  it("gives a target recorded before namespaces to the default namespace's next bootstrap, and no other", async () => {
    const [legacy] = await db
      .insert(target)
      .values({
        organizationId: orgId,
        vendor: "aws",
        account: "123456789012",
        region: "us-west-2",
      })
      .returning();

    const other = await prepareTarget(orgId, place("us-west-2", "staging"));
    const claimed = await prepareTarget(orgId, place("us-west-2", "ocel"));

    expect(legacy?.namespace).toBe("");
    expect(other.id).not.toBe(legacy?.id);
    expect(claimed).toMatchObject({ id: legacy?.id, namespace: "ocel" });
  });
});

describe("listing targets", () => {
  it("names the projects bound to each target, so its removal can say what goes", async () => {
    const used = await prepareTarget(orgId, place("ap-south-1"));
    const unused = await prepareTarget(orgId, place("ap-east-1"));
    await bindProject(db, { projectId, tier: "preview", targetId: used.id });

    const listed = (await targetsOf(orgId)).filter((found) =>
      [used.id, unused.id].includes(found.id),
    );

    expect(listed.find((found) => found.id === used.id)?.bound).toEqual([
      { slug: "w", tier: "preview" },
    ]);
    expect(listed.find((found) => found.id === unused.id)?.bound).toEqual([]);
    await unbindProject(projectId, "preview");
  });
});

describe("removing a target", () => {
  it("drops its tiers and bindings but keeps what it issued in the log", async () => {
    const removed = await prepareTarget(orgId, place("sa-east-1"));
    await recordTier(db, {
      targetId: removed.id,
      tier: "production",
      identity,
      cliVersion: "0.0.3",
    });
    await bindProject(db, { projectId, tier: "production", targetId: removed.id });
    const { jti } = await issue(db, issuer, {
      target: removed,
      tier: "production",
      lifetimeSeconds: 600,
      purpose: "deploy",
      projectId,
      principal: { kind: "pipeline", pipelineId: "p", jti: "gha", runUrl: "https://run" },
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
