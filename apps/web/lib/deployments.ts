import { db } from "@console/db";
import { type Deployment, deployment, environmentEvent, type Tier } from "@console/db/schema";
import { and, desc, eq, inArray, lt } from "drizzle-orm";

export function environmentKey(row: Pick<Deployment, "tier" | "environmentIdentity">) {
  return `${row.tier}/${row.environmentIdentity}`;
}

export type ActiveRun = Pick<
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

function runKey(row: Pick<Deployment, "projectId" | "tier" | "environmentIdentity">) {
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
  return new Map(rows.map((row) => [runKey(row), row.occurredAt]));
}

type Placed = Pick<Deployment, "projectId" | "tier" | "environmentIdentity" | "deployedAt">;

function tornDownAfter(tornDown: Map<string, Date>, run: Placed): Date | null {
  const at = tornDown.get(runKey(run));
  return at && at > run.deployedAt ? at : null;
}

async function activeRuns(projectIds: string[]): Promise<Map<string, ActiveRun>> {
  if (projectIds.length === 0) {
    return new Map();
  }
  const [rows, tornDown] = await Promise.all([succeededRuns(projectIds), teardowns(projectIds)]);
  return new Map(
    rows.filter((row) => !tornDownAfter(tornDown, row)).map((row) => [runKey(row), row]),
  );
}

async function succeededRuns(projectIds: string[]): Promise<ActiveRun[]> {
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

export type RunRow = Omit<Deployment, "trace" | "topology"> & {
  apps: Deployment["topology"]["apps"];
  active: boolean;
};

export type RunsLoad = { error: true } | { error: false; rows: RunRow[]; more: boolean };

export const RUNS_PAGE = 50;

export async function listRuns(
  projectIds: string[],
  tier: Tier | null,
  before: Date | null,
): Promise<RunsLoad> {
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
        .limit(RUNS_PAGE + 1),
      activeRuns(projectIds),
    ]);

    const page = rows.slice(0, RUNS_PAGE).map(({ trace: _trace, topology, ...row }) => ({
      ...row,
      apps: topology.apps,
      active: active.get(runKey(row))?.id === row.id,
    }));

    return { error: false, rows: page, more: rows.length > RUNS_PAGE };
  } catch {
    return { error: true };
  }
}

export type RunLoad =
  | { error: true }
  | { error: false; run: null }
  | { error: false; run: Deployment; active: ActiveRun | null };

export async function findRun(projectId: string, id: string): Promise<RunLoad> {
  try {
    const [[run], active] = await Promise.all([
      db
        .select()
        .from(deployment)
        .where(and(eq(deployment.projectId, projectId), eq(deployment.id, id))),
      activeRuns([projectId]),
    ]);
    if (!run) {
      return { error: false, run: null };
    }
    return { error: false, run, active: active.get(runKey(run)) ?? null };
  } catch {
    return { error: true };
  }
}

export type LatestRun = Pick<
  Deployment,
  "projectId" | "kind" | "outcome" | "deployedAt" | "providerName" | "providerRegion"
> & { tornDownAt: Date | null };

export async function latestRuns(projectIds: string[]): Promise<Map<string, LatestRun>> {
  if (projectIds.length === 0) {
    return new Map();
  }
  const [rows, tornDown] = await Promise.all([
    latestProductionRuns(projectIds),
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

async function latestProductionRuns(projectIds: string[]) {
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
