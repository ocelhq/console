import { db } from "@console/db";
import { type Deployment, deployment, TIERS, type Tier } from "@console/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { findOwnedProject } from "../owned";

function isTier(value: string | null): value is Tier {
  return value !== null && (TIERS as readonly string[]).includes(value);
}

function summary(row: Deployment) {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    kind: row.kind,
    promotionId: row.promotionId,
    tag: row.tag,
    environment: { tier: row.tier, identity: row.environmentIdentity },
    provider: { name: row.providerName, region: row.providerRegion },
    target: row.target,
    edgeKind: row.edgeKind,
    outcome: row.outcome,
    error: row.error,
    trigger: row.trigger,
    git: row.git,
    cliVersion: row.cliVersion,
    startedAt: row.startedAt?.getTime() ?? null,
    deployedAt: row.deployedAt.getTime(),
    apps: row.topology.apps.map((app) => ({
      name: app.name,
      outcome: app.outcome,
      urls: app.urls,
    })),
  };
}

export async function listDeployments(request: Request, id: string): Promise<Response> {
  const owned = await findOwnedProject(request, id);
  if (!owned.ok) {
    return owned.refusal;
  }

  const env = new URL(request.url).searchParams.get("env");
  const where = isTier(env)
    ? and(eq(deployment.projectId, owned.projectId), eq(deployment.tier, env))
    : eq(deployment.projectId, owned.projectId);

  const rows = await db
    .select()
    .from(deployment)
    .where(where)
    .orderBy(desc(deployment.deployedAt))
    .limit(50);

  return Response.json(rows.map(summary), { status: 200 });
}

export async function getDeployment(
  request: Request,
  id: string,
  deploymentId: string,
): Promise<Response> {
  const owned = await findOwnedProject(request, id);
  if (!owned.ok) {
    return owned.refusal;
  }

  const [row] = await db
    .select()
    .from(deployment)
    .where(and(eq(deployment.projectId, owned.projectId), eq(deployment.id, deploymentId)));

  if (!row) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return Response.json(
    {
      ...summary(row),
      trace: row.trace,
      apps: row.topology.apps,
      resources: row.topology.resources,
      usages: row.topology.usages,
    },
    { status: 200 },
  );
}
