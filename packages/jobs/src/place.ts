import { db } from "@console/db";
import { deployment, type JobKind, type Tier } from "@console/db/schema";
import { readCloudOffer } from "@console/endpoints";
import { and, desc, eq, ne } from "drizzle-orm";
import { boundRunner, OCEL_CLOUD_RUNNER, type RunnerRef, runnerIdOf } from "./bindings";

const OCEL_CLOUD_PROVIDER = "ocel";

export type Naming = "no-provider" | "provider" | "unknown";

export function statedNaming(provider: string): Naming {
  return provider === "" || provider === OCEL_CLOUD_PROVIDER ? "no-provider" : "provider";
}

export async function recordedNaming(projectId: string, tier: Tier): Promise<Naming> {
  const [latest] = await db
    .select({ provider: deployment.providerName })
    .from(deployment)
    .where(
      and(
        eq(deployment.projectId, projectId),
        eq(deployment.tier, tier),
        ne(deployment.providerName, ""),
      ),
    )
    .orderBy(desc(deployment.createdAt))
    .limit(1);
  return latest ? statedNaming(latest.provider) : "unknown";
}

export type Placement =
  | { ok: true; runner: RunnerRef; credentials: boolean }
  | { ok: false; message: string };

const refuse = (message: string): Placement => ({ ok: false, message });

export function refusedRunner(runner: RunnerRef, tier: Tier, naming: Naming): string | undefined {
  if (runner.kind === "ocel-cloud" && !readCloudOffer()) {
    return "this console does not offer Ocel Cloud's runner";
  }
  if (naming === "no-provider" && runner.kind !== "ocel-cloud") {
    return `the project names no provider, so it deploys to Ocel Cloud and its ${tier} jobs run only on Ocel Cloud's runner`;
  }
  return undefined;
}

export async function placeRunner(
  projectId: string,
  tier: Tier,
  naming: Naming,
): Promise<Placement> {
  const bound = await boundRunner(projectId, tier);
  if (!bound) {
    return naming === "no-provider" && readCloudOffer()
      ? { ok: true, runner: OCEL_CLOUD_RUNNER, credentials: false }
      : refuse(`bind a runner to ${tier}`);
  }
  const refused = refusedRunner(bound.runner, tier, naming);
  return refused
    ? refuse(refused)
    : { ok: true, runner: bound.runner, credentials: bound.credentials };
}

export interface JobPlace {
  projectId: string;
  tier: Tier;
  kind: JobKind;
  naming: Naming;
  runnerId?: string;
}

export async function placeJob(input: JobPlace): Promise<Placement> {
  const placed = await placeRunner(input.projectId, input.tier, input.naming);
  if (!placed.ok) return placed;
  const runnerId = runnerIdOf(placed.runner);
  if (input.runnerId && input.runnerId !== runnerId) {
    return refuse(`${input.tier} runs its jobs on runner ${runnerId}, not ${input.runnerId}`);
  }
  if (input.kind !== "build" && input.naming !== "no-provider" && !placed.credentials) {
    return refuse(
      `the runner bound to ${input.tier} gets no target credentials: an admin binds it again with credentials`,
    );
  }
  return placed;
}
