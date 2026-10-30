import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import {
  type Job,
  type JobEvent,
  JobEventLevel,
  type JobInput,
  JobPhase,
  JobState,
} from "@console/connectors/gen/runner/v1/runner_pb";
import type { Job as JobRow, JobStatus, Tier } from "@console/db/schema";
import { isTerminal, phaseOf, TIERS, WIRE_STATES } from "@console/jobs";

export type JobStateName =
  | "queued"
  | "running"
  | "input-required"
  | "succeeded"
  | "failed"
  | "canceled";

export type JobPhaseName =
  | "check"
  | "build"
  | "plan"
  | "provision"
  | "deploy"
  | "promote"
  | "destroy";

export type JobEventLevelName = "debug" | "info" | "warn" | "error";

export interface RunJob {
  id: string;
  projectId: string;
  deploymentId: string;
  state: JobStateName | null;
  phase: JobPhaseName | null;
  step: string;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error: { code: string; message: string } | null;
  result: {
    urls: string[];
    builds: { app: string; buildId: string }[];
  } | null;
  input: RunJobInput | null;
}

export interface NeededVariable {
  key: string;
  folder: string;
  secret: boolean;
  description: string;
  reason: string;
  group: string;
}

export interface NeededGroup {
  key: string;
  description: string;
}

export type RunJobInput =
  | {
      id: string;
      kind: "variables";
      tier: Tier | null;
      variables: NeededVariable[];
      groups: NeededGroup[];
    }
  | { id: string; kind: "confirmation"; finding: string; question: string }
  | { id: string; kind: "unknown" };

export interface RunJobEvent {
  seq: number;
  time: string | null;
  level: JobEventLevelName;
  phase: JobPhaseName | null;
  message: string;
}

const states: Partial<Record<JobState, JobStateName>> = {
  [JobState.QUEUED]: "queued",
  [JobState.RUNNING]: "running",
  [JobState.INPUT_REQUIRED]: "input-required",
  [JobState.SUCCEEDED]: "succeeded",
  [JobState.FAILED]: "failed",
  [JobState.CANCELED]: "canceled",
};

const phases: Partial<Record<JobPhase, JobPhaseName>> = {
  [JobPhase.CHECK]: "check",
  [JobPhase.BUILD]: "build",
  [JobPhase.PLAN]: "plan",
  [JobPhase.PROVISION]: "provision",
  [JobPhase.DEPLOY]: "deploy",
  [JobPhase.PROMOTE]: "promote",
  [JobPhase.DESTROY]: "destroy",
};

const levels: Partial<Record<JobEventLevel, JobEventLevelName>> = {
  [JobEventLevel.DEBUG]: "debug",
  [JobEventLevel.INFO]: "info",
  [JobEventLevel.WARN]: "warn",
  [JobEventLevel.ERROR]: "error",
};

export function runJobInputOf(input: JobInput | undefined): RunJobInput | null {
  if (!input) {
    return null;
  }
  const { need } = input;
  switch (need.case) {
    case "variables":
      return {
        id: input.id,
        kind: "variables",
        tier: TIERS[need.value.tier] ?? null,
        variables: need.value.variables.map((variable) => ({
          key: variable.key,
          folder: variable.folder,
          secret: variable.secret,
          description: variable.description,
          reason: variable.reason,
          group: variable.group,
        })),
        groups: need.value.groups.map((group) => ({
          key: group.key,
          description: group.description,
        })),
      };
    case "confirmation":
      return {
        id: input.id,
        kind: "confirmation",
        finding: need.value.finding,
        question: need.value.question,
      };
    default:
      return { id: input.id, kind: "unknown" };
  }
}

function isoOf(at: Timestamp | undefined): string | null {
  return at ? timestampDate(at).toISOString() : null;
}

export function runJobOf(job: Job): RunJob {
  return {
    id: job.id,
    projectId: job.projectId,
    deploymentId: job.deploymentId,
    state: states[job.state] ?? null,
    phase: phases[job.phase] ?? null,
    step: job.step,
    createdAt: isoOf(job.createdAt),
    startedAt: isoOf(job.startedAt),
    endedAt: isoOf(job.endedAt),
    error: job.error ? { code: job.error.code, message: job.error.message } : null,
    result: job.result
      ? {
          urls: [...job.result.urls],
          builds: job.result.builds.map((build) => ({ app: build.app, buildId: build.buildId })),
        }
      : null,
    input: runJobInputOf(job.input),
  };
}

export function runJobEventOf(event: JobEvent): RunJobEvent {
  return {
    seq: Number(event.seq),
    time: isoOf(event.time),
    level: levels[event.level] ?? "info",
    phase: phases[event.phase] ?? null,
    message: event.message,
  };
}

const HELD_STEPS = {
  held: "Held at the console until the job before it in this tier ends",
  sending: "Sent to its runner, which has not taken it yet",
} as const;

function heldStep(row: JobRow): string {
  const phase = phaseOf(row);
  if (phase !== "held" && phase !== "sending") return "";
  return row.note ? `${HELD_STEPS[phase]}: ${row.note}` : HELD_STEPS[phase];
}

function stateOfStatus(status: JobStatus): JobStateName | null {
  return states[WIRE_STATES[status]] ?? null;
}

export function runJobOfRow(row: JobRow): RunJob {
  return {
    id: row.id,
    projectId: row.projectId,
    deploymentId: row.deploymentId ?? "",
    state: stateOfStatus(row.status),
    phase: null,
    step: heldStep(row),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.finishedAt?.toISOString() ?? null,
    error: isTerminal(row.status) && row.error ? { code: row.status, message: row.error } : null,
    result: null,
    input: null,
  };
}
