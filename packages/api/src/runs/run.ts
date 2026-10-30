import {
  ask,
  done,
  type Outcome,
  reaches,
  refuse,
  scopeForCall,
  USER_SCOPES,
  ValueError,
} from "@console/connectors";
import {
  type Job as RunnerJob,
  RunnerService,
  type VariableValue,
} from "@console/connectors/gen/runner/v1/runner_pb";
import { db } from "@console/db";
import { deployment, type Job, job, project } from "@console/db/schema";
import { endpointOf, type Member, type Reach, reachOf } from "@console/endpoints";
import { followCancels, type JobDeps, leastRoleOfKind, stopJobs } from "@console/jobs";
import { and, eq } from "drizzle-orm";
import { type RunJob, type RunJobEvent, runJobEventOf, runJobOf, runJobOfRow } from "./view";

export const JOB_EVENTS_LIMIT = 1000;

export const STALE_INPUT = "This request is no longer current. The job has moved on.";

export const NOT_ALLOWED = "Your role in this organization does not allow this.";

export interface JobEvents {
  job: RunJob;
  events: RunJobEvent[];
  more: boolean;
}

export interface JobRun {
  events(afterSeq: number, limit?: number): Promise<Outcome<JobEvents>>;
  cancel(): Promise<Outcome<RunJob>>;
  answerConfirmation(inputId: string, confirmed: boolean): Promise<Outcome<RunJob>>;
  supplyVariables(inputId: string, values: VariableValue[]): Promise<Outcome<RunJob>>;
}

export interface ShownRun {
  job: Job;
  run: JobRun;
  mayGiveValues: boolean;
}

function jobOf(job: RunnerJob | undefined): RunJob {
  if (!job) throw new Error("the runner answered without the job");
  return runJobOf(job);
}

async function rowOf(id: string): Promise<Job> {
  const [found] = await db.select().from(job).where(eq(job.id, id));
  if (!found) throw new ValueError(404, `job ${id} is gone`);
  return found;
}

const actsOn = (row: Job, member: Member) => reaches(member.role, leastRoleOfKind(row.kind));

function canceling(row: Job, member: Member, deps: JobDeps): () => Promise<Outcome<RunJob>> {
  return async () => {
    if (
      scopeForCall(member.role, USER_SCOPES, RunnerService.method.cancelJob) === undefined ||
      !actsOn(row, member)
    ) {
      return refuse("denied", NOT_ALLOWED);
    }
    const now = deps.now?.() ?? new Date();
    const stopped = await db.transaction((tx) => stopJobs(tx, eq(job.id, row.id), now));
    await followCancels(stopped, deps, member.role);
    return done(runJobOfRow(await rowOf(row.id)));
  };
}

function heldAtConsole(row: Job, member: Member, deps: JobDeps): JobRun {
  const stale = async (): Promise<Outcome<RunJob>> => {
    throw new ValueError(409, STALE_INPUT);
  };
  return {
    events: async () => done({ job: runJobOfRow(await rowOf(row.id)), events: [], more: false }),
    cancel: canceling(row, member, deps),
    answerConfirmation: stale,
    supplyVariables: stale,
  };
}

function followedAtRunner(row: Job, reach: Reach, member: Member, deps: JobDeps): JobRun {
  const runner = reach.clients.runner;
  const jobId = row.id;
  return {
    events: (afterSeq, limit = JOB_EVENTS_LIMIT) =>
      ask(async () => {
        const answer = await runner.listJobEvents({
          jobId,
          afterSeq: BigInt(afterSeq),
          limit: Math.min(limit, JOB_EVENTS_LIMIT),
        });
        return {
          job: jobOf(answer.job),
          events: answer.events.map(runJobEventOf),
          more: answer.more,
        };
      }),
    cancel: canceling(row, member, deps),
    answerConfirmation: async (inputId, confirmed) =>
      actsOn(row, member)
        ? ask(async () =>
            jobOf((await runner.answerConfirmation({ jobId, inputId, confirmed })).job),
          )
        : refuse("denied", NOT_ALLOWED),
    supplyVariables: async (inputId, values) =>
      actsOn(row, member)
        ? ask(async () =>
            jobOf((await runner.supplyVariables({ jobId, inputId, variables: { values } })).job),
          )
        : refuse("denied", NOT_ALLOWED),
  };
}

function unreached(row: Job, member: Member, deps: JobDeps): JobRun {
  const offline = async (): Promise<Outcome<never>> =>
    refuse("offline", `Runner ${row.runnerId} has no address the console can reach`);
  return {
    events: offline,
    cancel: canceling(row, member, deps),
    answerConfirmation: offline,
    supplyVariables: offline,
  };
}

export async function runOfDeployment(
  deploymentId: string,
  member: Member,
  deps: JobDeps,
): Promise<ShownRun | undefined> {
  const [found] = await db
    .select({ job })
    .from(deployment)
    .innerJoin(project, eq(project.id, deployment.projectId))
    .innerJoin(job, and(eq(job.id, deployment.jobId), eq(job.projectId, deployment.projectId)))
    .where(and(eq(deployment.id, deploymentId), eq(project.organizationId, member.organizationId)));
  return found && shownRun(found.job, member, deps);
}

export async function runOfJob(
  jobId: string,
  member: Member,
  deps: JobDeps,
): Promise<ShownRun | undefined> {
  const [found] = await db
    .select({ job })
    .from(job)
    .innerJoin(project, eq(project.id, job.projectId))
    .where(and(eq(job.id, jobId), eq(project.organizationId, member.organizationId)));
  return found && shownRun(found.job, member, deps);
}

async function shownRun(row: Job, member: Member, deps: JobDeps): Promise<ShownRun | undefined> {
  if (!row.runnerId) return undefined;
  if (row.acknowledgedAt === null) {
    return { job: row, run: heldAtConsole(row, member, deps), mayGiveValues: false };
  }
  const endpoint = await endpointOf(member.organizationId, row.runnerId);
  const reach = endpoint && reachOf(member, endpoint);
  if (!reach) return { job: row, run: unreached(row, member, deps), mayGiveValues: false };
  return {
    job: row,
    run: followedAtRunner(row, reach, member, deps),
    mayGiveValues:
      actsOn(row, member) && reach.scopeFor(RunnerService.method.supplyVariables) !== undefined,
  };
}
