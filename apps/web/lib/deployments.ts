import { db } from "@console/db";
import { type Deployment, deployment, environmentEvent, type Tier } from "@console/db/schema";
import { and, desc, eq, inArray, lt } from "drizzle-orm";

export function environmentKey(row: Pick<Deployment, "tier" | "environmentIdentity">) {
  return `${row.tier}/${row.environmentIdentity}`;
}

export type ActiveDeployment = Pick<
  Deployment,
  | "id"
  | "projectId"
  | "kind"
  | "promotionId"
  | "tag"
  | "tier"
  | "environmentIdentity"
  | "deployedAt"
>;

function placeKey(row: Pick<Deployment, "projectId" | "tier" | "environmentIdentity">) {
  return `${row.projectId}/${environmentKey(row)}`;
}

async function teardowns(projectIds: string[]): Promise<Map<string, Date>> {
  const rows = await db
    .selectDistinctOn(
      [environmentEvent.projectId, environmentEvent.tier, environmentEvent.environmentIdentity],
      {
        projectId: environmentEvent.projectId,
        tier: environmentEvent.tier,
        environmentIdentity: environmentEvent.environmentIdentity,
        occurredAt: environmentEvent.occurredAt,
      },
    )
    .from(environmentEvent)
    .where(inArray(environmentEvent.projectId, projectIds))
    .orderBy(
      environmentEvent.projectId,
      environmentEvent.tier,
      environmentEvent.environmentIdentity,
      desc(environmentEvent.occurredAt),
    );
  return new Map(rows.map((row) => [placeKey(row), row.occurredAt]));
}

type Placed = Pick<Deployment, "projectId" | "tier" | "environmentIdentity" | "deployedAt">;

function tornDownAfter(tornDown: Map<string, Date>, placed: Placed): Date | null {
  const at = tornDown.get(placeKey(placed));
  return at && at > placed.deployedAt ? at : null;
}

async function activeDeployments(projectIds: string[]): Promise<Map<string, ActiveDeployment>> {
  if (projectIds.length === 0) {
    return new Map();
  }
  const [rows, tornDown] = await Promise.all([
    succeededDeployments(projectIds),
    teardowns(projectIds),
  ]);
  return new Map(
    rows.filter((row) => !tornDownAfter(tornDown, row)).map((row) => [placeKey(row), row]),
  );
}

async function succeededDeployments(projectIds: string[]): Promise<ActiveDeployment[]> {
  return db
    .selectDistinctOn([deployment.projectId, deployment.tier, deployment.environmentIdentity], {
      id: deployment.id,
      projectId: deployment.projectId,
      kind: deployment.kind,
      promotionId: deployment.promotionId,
      tag: deployment.tag,
      tier: deployment.tier,
      environmentIdentity: deployment.environmentIdentity,
      deployedAt: deployment.deployedAt,
    })
    .from(deployment)
    .where(and(inArray(deployment.projectId, projectIds), eq(deployment.outcome, "succeeded")))
    .orderBy(
      deployment.projectId,
      deployment.tier,
      deployment.environmentIdentity,
      desc(deployment.deployedAt),
    );
}

export type OverviewLoad =
  | { error: true }
  | {
      error: false;
      latest: Deployment | null;
      lastPromoted: Deployment | null;
      tornDownAt: Date | null;
    };

export async function latestDeployments(projectId: string, tier: Tier): Promise<OverviewLoad> {
  const scope = and(eq(deployment.projectId, projectId), eq(deployment.tier, tier));

  try {
    const [[latest], [lastPromoted], tornDown] = await Promise.all([
      db.select().from(deployment).where(scope).orderBy(desc(deployment.deployedAt)).limit(1),
      db
        .select()
        .from(deployment)
        .where(and(scope, eq(deployment.outcome, "succeeded")))
        .orderBy(desc(deployment.deployedAt))
        .limit(1),
      teardowns([projectId]),
    ]);

    return {
      error: false,
      latest: latest ?? null,
      lastPromoted: lastPromoted ?? null,
      tornDownAt: latest ? tornDownAfter(tornDown, latest) : null,
    };
  } catch {
    return { error: true };
  }
}

export type DeploymentRow = Omit<Deployment, "trace" | "topology"> & {
  apps: Deployment["topology"]["apps"];
  active: boolean;
};

export type DeploymentsLoad =
  | { error: true }
  | { error: false; rows: DeploymentRow[]; more: boolean };

export const DEPLOYMENTS_PAGE = 50;

export async function listDeployments(
  projectIds: string[],
  tier: Tier | null,
  before: Date | null,
): Promise<DeploymentsLoad> {
  if (projectIds.length === 0) {
    return { error: false, rows: [], more: false };
  }
  const filters = [inArray(deployment.projectId, projectIds)];
  if (tier) {
    filters.push(eq(deployment.tier, tier));
  }
  if (before) {
    filters.push(lt(deployment.deployedAt, before));
  }

  try {
    const [rows, active] = await Promise.all([
      db
        .select()
        .from(deployment)
        .where(and(...filters))
        .orderBy(desc(deployment.deployedAt))
        .limit(DEPLOYMENTS_PAGE + 1),
      activeDeployments(projectIds),
    ]);

    const page = rows.slice(0, DEPLOYMENTS_PAGE).map(({ trace: _trace, topology, ...row }) => ({
      ...row,
      apps: topology.apps,
      active: active.get(placeKey(row))?.id === row.id,
    }));

    return { error: false, rows: page, more: rows.length > DEPLOYMENTS_PAGE };
  } catch {
    return { error: true };
  }
}

export type DeploymentLoad =
  | { error: true }
  | { error: false; deployment: null }
  | { error: false; deployment: Deployment; active: ActiveDeployment | null };

export async function findDeployment(projectId: string, id: string): Promise<DeploymentLoad> {
  try {
    const [[found], active] = await Promise.all([
      db
        .select()
        .from(deployment)
        .where(and(eq(deployment.projectId, projectId), eq(deployment.id, id))),
      activeDeployments([projectId]),
    ]);
    if (!found) {
      return { error: false, deployment: null };
    }
    return { error: false, deployment: found, active: active.get(placeKey(found)) ?? null };
  } catch {
    return { error: true };
  }
}

export type LatestDeployment = Pick<
  Deployment,
  "projectId" | "kind" | "outcome" | "deployedAt" | "providerName" | "providerRegion"
> & { tornDownAt: Date | null };

export async function latestDeploymentByProject(
  projectIds: string[],
): Promise<Map<string, LatestDeployment>> {
  if (projectIds.length === 0) {
    return new Map();
  }
  const [rows, tornDown] = await Promise.all([
    latestProductionDeployments(projectIds),
    teardowns(projectIds),
  ]);
  return new Map(
    rows.map((row) => [
      row.projectId,
      {
        ...row,
        tornDownAt: tornDownAfter(tornDown, {
          ...row,
          tier: "production",
          environmentIdentity: "",
        }),
      },
    ]),
  );
}

async function latestProductionDeployments(projectIds: string[]) {
  return db
    .selectDistinctOn([deployment.projectId], {
      projectId: deployment.projectId,
      kind: deployment.kind,
      outcome: deployment.outcome,
      deployedAt: deployment.deployedAt,
      providerName: deployment.providerName,
      providerRegion: deployment.providerRegion,
    })
    .from(deployment)
    .where(and(inArray(deployment.projectId, projectIds), eq(deployment.tier, "production")))
    .orderBy(deployment.projectId, desc(deployment.deployedAt));
}
