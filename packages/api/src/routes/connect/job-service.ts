import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { highestRole, roleOf } from "@console/auth";
import { leastRoleOf, reaches } from "@console/connectors";
import {
  type DispatchedJob,
  DispatchedJobSchema,
  type JobService,
} from "@console/connectors/gen/console/v1/job_pb";
import { JobCommandSchema } from "@console/connectors/gen/runner/v1/runner_pb";
import { db } from "@console/db";
import { type Job, job, project, user } from "@console/db/schema";
import { endpointOf } from "@console/endpoints";
import {
  COMMANDS,
  isTerminal,
  type JobDeps,
  KINDS,
  placeJob,
  recordDispatch,
  runnerIdOf,
  sendJob,
  statedNaming,
  TIERS,
  uploadedSpecOf,
  WIRE_STATES,
  WIRE_TIERS,
} from "@console/jobs";
import { and, eq } from "drizzle-orm";
import { sessionOf } from "./caller";
import { required } from "./required";

export type JobServiceDeps = () => JobDeps;

function dispatchedOf(row: Job): DispatchedJob {
  return create(DispatchedJobSchema, {
    id: row.id,
    projectId: row.projectId,
    tier: WIRE_TIERS[row.tier],
    runnerId: row.runnerId ?? "",
    deploymentId: row.deploymentId ?? "",
    command: COMMANDS[row.kind],
    state: WIRE_STATES[row.status],
    ...(isTerminal(row.status) && row.error
      ? { error: { code: row.status, message: row.error } }
      : {}),
    createdAt: timestampFromDate(row.createdAt),
    ...(row.finishedAt ? { endedAt: timestampFromDate(row.finishedAt) } : {}),
  });
}

async function ownedProject(organizationId: string, projectId: string) {
  const [found] = await db
    .select({ id: project.id, slug: project.slug })
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.organizationId, organizationId)));
  if (!found) {
    throw new ConnectError(`No project ${projectId} in the session's organization`, Code.NotFound);
  }
  return found;
}

async function jobIn(projectId: string, where: ReturnType<typeof eq>): Promise<Job | undefined> {
  const [found] = await db
    .select()
    .from(job)
    .where(and(eq(job.projectId, projectId), where));
  return found;
}

async function nameOf(userId: string): Promise<string | undefined> {
  const [found] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  return found?.name || undefined;
}

export function jobService(deps: JobServiceDeps): ServiceImpl<typeof JobService> {
  return {
    async dispatch(request, context) {
      const session = sessionOf(context);
      const wanted = required(request.job, "job");
      const command = JobCommandSchema.value[wanted.command];
      const kind = KINDS[wanted.command];
      const tier = TIERS[request.tier];
      if (!command || !kind || !tier) {
        throw new ConnectError(
          "protovalidate let through an unknown command or tier",
          Code.Internal,
        );
      }
      const role = highestRole(await roleOf(session.userId, session.activeOrganizationId));
      if (!reaches(role, leastRoleOf(command))) {
        throw new ConnectError(
          `Your role in this organization does not allow ${kind} jobs`,
          Code.PermissionDenied,
        );
      }
      const owned = await ownedProject(session.activeOrganizationId, request.projectId);
      if (request.slug !== "" && request.slug !== owned.slug) {
        throw new ConnectError(
          `The project's slug is ${owned.slug}, not ${request.slug}: link the project again`,
          Code.FailedPrecondition,
        );
      }
      const spec = uploadedSpecOf(wanted);
      if (!spec) {
        throw new ConnectError(
          "A dispatched job runs a source uploaded to its runner",
          Code.InvalidArgument,
        );
      }

      const repeated = await jobIn(owned.id, eq(job.dedupeKey, request.requestId));
      if (repeated) return { job: dispatchedOf(repeated) };

      const placed = await placeJob({
        projectId: owned.id,
        tier,
        kind,
        naming: statedNaming(request.provider),
        runnerId: request.runnerId,
      });
      if (!placed.ok) {
        throw new ConnectError(placed.message, Code.FailedPrecondition);
      }

      const runnerId = runnerIdOf(placed.runner);
      const [actor, runner] = await Promise.all([
        nameOf(session.userId),
        endpointOf(session.activeOrganizationId, runnerId),
      ]);
      const { job: made, created } = await db.transaction((tx) =>
        recordDispatch(tx, {
          projectId: owned.id,
          tier,
          kind,
          requestId: request.requestId,
          runnerId,
          spec,
          pr: wanted.git?.pullRequest ?? 0,
          sha: wanted.git?.commit || null,
          branch: wanted.git?.branch || null,
          eventAt: new Date(),
          trigger: {
            kind: "cli",
            ...(actor ? { actor } : {}),
            remote: { runner: runner?.name ?? runnerId },
          },
        }),
      );
      const sent = created ? await sendJob(made.id, deps()) : made;
      return { job: dispatchedOf(sent ?? made) };
    },

    async get(request, context) {
      const session = sessionOf(context);
      const owned = await ownedProject(session.activeOrganizationId, request.projectId);
      const found = await jobIn(owned.id, eq(job.id, request.jobId));
      if (!found) {
        throw new ConnectError(`No job ${request.jobId} in project ${owned.id}`, Code.NotFound);
      }
      return { job: dispatchedOf(found) };
    },
  };
}
