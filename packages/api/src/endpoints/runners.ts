import { Code } from "@connectrpc/connect";
import { RunnerService } from "@console/connectors/gen/runner/v1/runner_pb";
import { db } from "@console/db";
import { project, type Tier } from "@console/db/schema";
import {
  consoleMember,
  endpointOf,
  type ResolvedEndpoint,
  reachOf,
  servesRunner,
} from "@console/endpoints";
import {
  bind,
  placeRunner,
  recordedNaming,
  refusedRunner,
  runnerIdOf,
  runnerNamed,
  statedNaming,
  unbind,
} from "@console/jobs";
import { and, eq } from "drizzle-orm";
import { type EndpointMessage, endpointMessage } from "./message";

export type Refused = { ok: false; code: Code; message: string };

export type Answer<T = Record<string, never>> = { ok: true; value: T } | Refused;

const bound: Answer = { ok: true, value: {} };

const refuse = (code: Code, message: string): Refused => ({ ok: false, code, message });

async function owned(organizationId: string, projectId: string): Promise<Refused | undefined> {
  const [found] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.organizationId, organizationId), eq(project.id, projectId)));
  return found ? undefined : refuse(Code.NotFound, `No project ${projectId} in the organization`);
}

const FOLLOWED_WITH = [RunnerService.method.getJob, RunnerService.method.cancelJob];

function unfollowable(endpoint: ResolvedEndpoint): string | undefined {
  if (!servesRunner(endpoint)) {
    return `Endpoint ${endpoint.name} serves no ${RunnerService.typeName}: enable its runner role, and bind it once its heartbeat reports the runner`;
  }
  const reach = reachOf(consoleMember(endpoint.organizationId), endpoint);
  if (!reach) {
    return `Endpoint ${endpoint.name} has no address the console can reach`;
  }
  const refused = FOLLOWED_WITH.filter((call) => reach.scopeFor(call) === undefined);
  if (refused.length > 0) {
    return `Endpoint ${endpoint.name} does not allow the scopes the console follows and cancels its jobs with (${refused.map((call) => call.name).join(", ")}): add them to its allowed scopes`;
  }
  return undefined;
}

export interface Binding {
  projectId: string;
  tier: Tier;
  runnerId: string;
  credentials: boolean;
}

export async function bindRunner(organizationId: string, binding: Binding): Promise<Answer> {
  const missing = await owned(organizationId, binding.projectId);
  if (missing) return missing;
  const runner = runnerNamed(binding.runnerId);
  const endpoint = await endpointOf(organizationId, binding.runnerId);
  if (!endpoint) {
    return runner.kind === "ocel-cloud"
      ? refuse(
          Code.FailedPrecondition,
          "This console offers no Ocel Cloud, so it has no Ocel Cloud runner",
        )
      : refuse(Code.NotFound, `No endpoint ${binding.runnerId} in the organization`);
  }
  const refused =
    unfollowable(endpoint) ??
    refusedRunner(runner, binding.tier, await recordedNaming(binding.projectId, binding.tier));
  if (refused) return refuse(Code.FailedPrecondition, refused);
  await bind(binding.projectId, {
    tier: binding.tier,
    runner,
    credentials: binding.credentials,
  });
  return bound;
}

export async function unbindRunner(
  organizationId: string,
  projectId: string,
  tier: Tier,
): Promise<Answer> {
  const missing = await owned(organizationId, projectId);
  if (missing) return missing;
  await unbind(projectId, tier);
  return bound;
}

export async function resolveRunner(
  organizationId: string,
  request: { projectId: string; tier: Tier; provider: string },
): Promise<Answer<{ runner: EndpointMessage; credentials: boolean }>> {
  const missing = await owned(organizationId, request.projectId);
  if (missing) return missing;
  const placed = await placeRunner(request.projectId, request.tier, statedNaming(request.provider));
  if (!placed.ok) return refuse(Code.FailedPrecondition, placed.message);
  const endpoint = await endpointOf(organizationId, runnerIdOf(placed.runner));
  if (!endpoint) {
    return refuse(Code.FailedPrecondition, `Runner ${runnerIdOf(placed.runner)} is gone`);
  }
  return {
    ok: true,
    value: { runner: endpointMessage(endpoint), credentials: placed.credentials },
  };
}
