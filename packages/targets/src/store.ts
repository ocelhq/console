import { db, type Executor } from "@console/db";
import {
  credentialIssuance,
  type IssuancePrincipal,
  project,
  type Target,
  type TargetTier,
  type Tier,
  target,
  targetBinding,
  targetTier,
} from "@console/db/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { TierIdentity } from "./vendors";

export interface TargetPlace {
  vendor: string;
  account: string;
  region: string;
}

export async function prepareTarget(organizationId: string, place: TargetPlace): Promise<Target> {
  await db
    .insert(target)
    .values({ organizationId, ...place })
    .onConflictDoNothing();
  const [found] = await db
    .select()
    .from(target)
    .where(
      and(
        eq(target.organizationId, organizationId),
        eq(target.vendor, place.vendor),
        eq(target.account, place.account),
        eq(target.region, place.region),
      ),
    );
  if (!found) throw new Error("the target was not stored");
  return found;
}

export async function targetOf(
  organizationId: string,
  targetId: string,
): Promise<Target | undefined> {
  const [found] = await db
    .select()
    .from(target)
    .where(and(eq(target.organizationId, organizationId), eq(target.id, targetId)));
  return found;
}

export async function projectInOrganization(
  organizationId: string,
  projectId: string,
): Promise<boolean> {
  const [found] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.organizationId, organizationId), eq(project.id, projectId)));
  return found !== undefined;
}

export interface RecordedTier {
  targetId: string;
  tier: Tier;
  identity: TierIdentity;
  grants: string[];
  cliVersion: string;
}

export async function recordTier(tx: Executor, recorded: RecordedTier): Promise<void> {
  const values = {
    identityProvider: recorded.identity.identityProvider,
    principal: recorded.identity.principal,
    grants: recorded.grants,
    cliVersion: recorded.cliVersion,
    recordedAt: sql`now()`,
  };
  await tx
    .insert(targetTier)
    .values({ targetId: recorded.targetId, tier: recorded.tier, ...values })
    .onConflictDoUpdate({ target: [targetTier.targetId, targetTier.tier], set: values });
}

export async function bindProject(
  tx: Executor,
  binding: { projectId: string; tier: Tier; targetId: string },
): Promise<void> {
  await tx
    .insert(targetBinding)
    .values(binding)
    .onConflictDoUpdate({
      target: [targetBinding.projectId, targetBinding.tier],
      set: { targetId: binding.targetId },
    });
}

export async function unbindProject(projectId: string, tier: Tier): Promise<void> {
  await db
    .delete(targetBinding)
    .where(and(eq(targetBinding.projectId, projectId), eq(targetBinding.tier, tier)));
}

export interface Bound {
  target: Target;
  tier: TargetTier | null;
}

export async function boundTarget(projectId: string, tier: Tier): Promise<Bound | undefined> {
  const [found] = await db
    .select({ target, tier: targetTier })
    .from(targetBinding)
    .innerJoin(target, eq(target.id, targetBinding.targetId))
    .leftJoin(
      targetTier,
      and(eq(targetTier.targetId, targetBinding.targetId), eq(targetTier.tier, targetBinding.tier)),
    )
    .where(and(eq(targetBinding.projectId, projectId), eq(targetBinding.tier, tier)));
  return found;
}

export async function bindingsOf(projectId: string): Promise<{ tier: Tier; targetId: string }[]> {
  return db
    .select({ tier: targetBinding.tier, targetId: targetBinding.targetId })
    .from(targetBinding)
    .where(eq(targetBinding.projectId, projectId));
}

export async function tierOf(targetId: string, tier: Tier): Promise<TargetTier | undefined> {
  const [found] = await db
    .select()
    .from(targetTier)
    .where(and(eq(targetTier.targetId, targetId), eq(targetTier.tier, tier)));
  return found;
}

export interface TargetWithTiers extends Target {
  tiers: TargetTier[];
}

export async function targetsOf(organizationId: string): Promise<TargetWithTiers[]> {
  const targets = await db
    .select()
    .from(target)
    .where(eq(target.organizationId, organizationId))
    .orderBy(asc(target.vendor), asc(target.account), asc(target.region));
  if (targets.length === 0) return [];
  const tiers = await db
    .select({ tier: targetTier })
    .from(targetTier)
    .innerJoin(target, eq(target.id, targetTier.targetId))
    .where(eq(target.organizationId, organizationId))
    .orderBy(desc(targetTier.tier));
  return targets.map((found) => ({
    ...found,
    tiers: tiers.map((row) => row.tier).filter((row) => row.targetId === found.id),
  }));
}

export async function removeTarget(organizationId: string, targetId: string): Promise<boolean> {
  const removed = await db
    .delete(target)
    .where(and(eq(target.organizationId, organizationId), eq(target.id, targetId)))
    .returning({ id: target.id });
  return removed.length > 0;
}

export interface Issuance {
  organizationId: string;
  projectId: string | null;
  targetId: string;
  tier: Tier;
  principal: IssuancePrincipal;
  tokenJti: string;
  issuedAt: Date;
  expiresAt: Date;
}

export async function recordIssuance(tx: Executor, issuance: Issuance): Promise<void> {
  await tx.insert(credentialIssuance).values(issuance);
  await tx
    .update(targetTier)
    .set({ lastIssuedAt: issuance.issuedAt })
    .where(and(eq(targetTier.targetId, issuance.targetId), eq(targetTier.tier, issuance.tier)));
}

export async function issuancesOf(
  scope: { organizationId: string; projectId?: string },
  limit = 50,
) {
  return db
    .select({
      id: credentialIssuance.id,
      projectId: credentialIssuance.projectId,
      projectSlug: project.slug,
      targetId: credentialIssuance.targetId,
      vendor: target.vendor,
      account: target.account,
      region: target.region,
      tier: credentialIssuance.tier,
      principal: credentialIssuance.principal,
      tokenJti: credentialIssuance.tokenJti,
      issuedAt: credentialIssuance.issuedAt,
      expiresAt: credentialIssuance.expiresAt,
    })
    .from(credentialIssuance)
    .leftJoin(project, eq(project.id, credentialIssuance.projectId))
    .leftJoin(target, eq(target.id, credentialIssuance.targetId))
    .where(
      and(
        eq(credentialIssuance.organizationId, scope.organizationId),
        scope.projectId === undefined
          ? undefined
          : eq(credentialIssuance.projectId, scope.projectId),
      ),
    )
    .orderBy(desc(credentialIssuance.issuedAt))
    .limit(limit);
}

export type IssuanceRow = Awaited<ReturnType<typeof issuancesOf>>[number];
