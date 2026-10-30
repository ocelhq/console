import { db } from "@console/db";
import { type RunnerBinding, runnerBinding, type Tier } from "@console/db/schema";
import { OCEL_CLOUD_ID } from "@console/endpoints";
import { and, eq } from "drizzle-orm";

export type RunnerRef = { kind: "ocel-cloud" } | { kind: "endpoint"; id: string };

export const OCEL_CLOUD_RUNNER: RunnerRef = { kind: "ocel-cloud" };

export function runnerIdOf(runner: RunnerRef): string {
  return runner.kind === "ocel-cloud" ? OCEL_CLOUD_ID : runner.id;
}

export function runnerNamed(id: string): RunnerRef {
  return id === OCEL_CLOUD_ID ? OCEL_CLOUD_RUNNER : { kind: "endpoint", id };
}

export interface Bound {
  tier: Tier;
  runner: RunnerRef;
  credentials: boolean;
}

function boundOf(row: RunnerBinding): Bound {
  return {
    tier: row.tier,
    runner:
      row.runner === "endpoint" && row.endpointId !== null
        ? { kind: "endpoint", id: row.endpointId }
        : OCEL_CLOUD_RUNNER,
    credentials: row.credentials,
  };
}

export async function boundRunner(projectId: string, tier: Tier): Promise<Bound | undefined> {
  const [found] = await db
    .select()
    .from(runnerBinding)
    .where(and(eq(runnerBinding.projectId, projectId), eq(runnerBinding.tier, tier)));
  return found && boundOf(found);
}

export async function boundRunners(projectId: string): Promise<Bound[]> {
  const rows = await db.select().from(runnerBinding).where(eq(runnerBinding.projectId, projectId));
  return rows.map(boundOf);
}

export async function bind(projectId: string, binding: Bound): Promise<void> {
  const values = {
    runner: binding.runner.kind,
    endpointId: binding.runner.kind === "endpoint" ? binding.runner.id : null,
    credentials: binding.credentials,
  };
  await db
    .insert(runnerBinding)
    .values({ projectId, tier: binding.tier, ...values })
    .onConflictDoUpdate({
      target: [runnerBinding.projectId, runnerBinding.tier],
      set: { ...values, boundAt: new Date() },
    });
}

export async function unbind(projectId: string, tier: Tier): Promise<void> {
  await db
    .delete(runnerBinding)
    .where(and(eq(runnerBinding.projectId, projectId), eq(runnerBinding.tier, tier)));
}
