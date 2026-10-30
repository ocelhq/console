import { randomBytes, randomUUID } from "node:crypto";
import type { RolledBack } from "@console/connectors";
import { db } from "@console/db";
import { type Deployment, deployment, user } from "@console/db/schema";
import { eq } from "drizzle-orm";

export function rollbackable(
  from: Pick<Deployment, "id" | "tier" | "outcome" | "promotionId">,
  active: Pick<Deployment, "id"> | null,
): from is typeof from & { promotionId: string } {
  return (
    from.tier === "production" &&
    from.outcome === "succeeded" &&
    from.promotionId !== null &&
    active?.id !== from.id
  );
}

async function actorOf(userId: string): Promise<string | undefined> {
  const [found] = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId));
  return found?.name || found?.email || undefined;
}

export async function recordRollback(
  from: Deployment,
  rolled: RolledBack,
  userId: string,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const actor = await actorOf(userId);
  await db.insert(deployment).values({
    id,
    projectId: from.projectId,
    deploymentId: randomBytes(16).toString("hex"),
    kind: "rollback",
    tier: "production",
    promotionId: rolled.promotionId,
    tag: from.tag,
    providerName: from.providerName,
    providerRegion: from.providerRegion,
    target: from.target,
    edgeKind: from.edgeKind,
    outcome: "succeeded",
    outcomeBy: "console",
    trigger: { kind: "console", ...(actor ? { actor } : {}) },
    principal: { kind: "session", userId },
    startedAt: now,
    deployedAt: now,
    topology: {
      ...from.topology,
      apps: from.topology.apps.map((app) => ({
        ...app,
        release: rolled.releases[app.name] ?? app.release,
      })),
    },
  });
  return id;
}
