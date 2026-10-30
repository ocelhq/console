import { Code, ConnectError } from "@connectrpc/connect";
import { Role } from "@console/connectors";
import { db } from "@console/db";
import { type Job, job, project } from "@console/db/schema";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { type JobDeps, nowOf } from "./deps";
import { noGitToken } from "./git-token";
import { leastRoleOfKind, requestOf } from "./request";
import type { JobAt } from "./runner";
import { type DispatchedJob, dispatched, isHeld, isReleased, phaseOf } from "./state";
import { signJobToken } from "./token";
import { applyRunnerJob, endJob, markUnreachable, messageOf, noteBusy } from "./transitions";

const REFUSALS: ReadonlySet<Code> = new Set([
  Code.InvalidArgument,
  Code.NotFound,
  Code.FailedPrecondition,
  Code.OutOfRange,
  Code.PermissionDenied,
  Code.Unauthenticated,
  Code.Unimplemented,
]);

const lane = (row: Pick<Job, "projectId" | "tier" | "lane">) =>
  sql`select pg_advisory_xact_lock(hashtext(${`${row.projectId}:${row.tier}:${row.lane}`}))`;

const sameLane = (row: Job) =>
  and(
    eq(job.projectId, row.projectId),
    eq(job.tier, row.tier),
    eq(job.lane, row.lane),
    ne(job.id, row.id),
  );

async function released(jobId: string, now: Date): Promise<Job | undefined> {
  return db.transaction(async (tx) => {
    const [held] = await tx.select().from(job).where(eq(job.id, jobId));
    if (!held || phaseOf(held) !== "held") return held;
    await tx.execute(lane(held));
    const [busy] = await tx
      .select({ id: job.id })
      .from(job)
      .where(and(sameLane(held), isReleased));
    if (busy) return held;
    const [earlier] = await tx
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          sameLane(held),
          isHeld,
          sql`(${job.createdAt}, ${job.id}) < (select o.created_at, o.id from job o where o.id = ${held.id})`,
        ),
      )
      .limit(1);
    if (earlier) return held;
    const [made] = await tx
      .update(job)
      .set({ dispatchedAt: now })
      .where(and(eq(job.id, held.id), isNull(job.dispatchedAt)))
      .returning();
    return made;
  });
}

async function owner(projectId: string) {
  const [found] = await db
    .select({ organizationId: project.organizationId, slug: project.slug })
    .from(project)
    .where(eq(project.id, projectId));
  if (!found) throw new Error(`project ${projectId} is gone`);
  return found;
}

export function jobAt(row: DispatchedJob, organizationId: string): JobAt {
  return { jobId: row.id, organizationId, runnerId: row.runnerId };
}

async function start(row: DispatchedJob, deps: JobDeps): Promise<Job | undefined> {
  const now = nowOf(deps);
  const { organizationId, slug } = await owner(row.projectId);
  try {
    if (!row.spec) throw new Error(`job ${row.id} records nothing to run`);
    const gitToken =
      "git" in row.spec.source ? await (deps.gitToken ?? noGitToken)(row.projectId) : undefined;
    const { token } = await signJobToken(
      {
        organizationId,
        projectId: row.projectId,
        tier: row.tier,
        jobId: row.id,
        deploymentId: row.deploymentId,
        preview: row.spec.preview?.name ?? null,
        runnerId: row.runnerId,
        slug,
      },
      now,
    );
    const started = await deps.runners.start(
      jobAt(row, organizationId),
      requestOf(row, row.spec, gitToken),
      token,
    );
    return await applyRunnerJob(row, started, deps);
  } catch (thrown) {
    if (thrown instanceof ConnectError && REFUSALS.has(thrown.code)) {
      return endJob(row, "failed", `The runner refused the job: ${thrown.rawMessage}`, deps);
    }
    if (thrown instanceof ConnectError && thrown.code === Code.ResourceExhausted) {
      await noteBusy(row, thrown.rawMessage);
    } else {
      await markUnreachable(row, messageOf(thrown), now);
    }
    return undefined;
  }
}

export async function sendJob(jobId: string, deps: JobDeps): Promise<Job | undefined> {
  const row = await released(jobId, nowOf(deps));
  if (!row || phaseOf(row) !== "sending") return row;
  if (row.cancelRequested) return cancelJob(row, deps);
  return (await start(dispatched(row), deps)) ?? row;
}

export async function cancelJob(row: Job, deps: JobDeps, role?: Role): Promise<Job | undefined> {
  switch (phaseOf(row)) {
    case "ended":
      return row;
    case "held":
      return endJob(row, "canceled", null, deps);
    case "sending":
    case "following": {
      const sent = dispatched(row);
      const { organizationId } = await owner(row.projectId);
      try {
        return await applyRunnerJob(
          row,
          await deps.runners.cancel(
            jobAt(sent, organizationId),
            role ?? leastRoleOfKind(row.kind) ?? Role.UNSPECIFIED,
          ),
          deps,
        );
      } catch (thrown) {
        if (thrown instanceof ConnectError && thrown.code === Code.NotFound) {
          return endJob(row, "canceled", null, deps);
        }
        await markUnreachable(row, messageOf(thrown), nowOf(deps));
        return undefined;
      }
    }
  }
}
