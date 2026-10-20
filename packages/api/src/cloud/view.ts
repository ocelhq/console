import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import {
  type Job,
  JobCommand,
  type JobEvent,
  JobEventLevel,
  type JobInput,
  JobPhase,
  JobState,
} from "@console/connectors/gen/cloud/v1/job_pb";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";

export type JobCommandName = "build" | "deploy" | "preview-up";

export type JobStateName =
  | "queued"
  | "running"
  | "input-required"
  | "succeeded"
  | "failed"
  | "canceled";

export type JobPhaseName = "check" | "build" | "plan" | "provision" | "deploy" | "promote";

export type JobEventLevelName = "debug" | "info" | "warn" | "error";

export interface CloudJob {
  id: string;
  projectId: string;
  command: JobCommandName | null;
  state: JobStateName | null;
  phase: JobPhaseName | null;
  step: string;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error: { code: string; message: string } | null;
  result: {
    urls: string[];
    deploymentId: string;
    builds: { app: string; buildId: string }[];
  } | null;
  sourceId: string;
  input: CloudJobInput | null;
}

export type TierName = "production" | "preview";

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

export type CloudJobInput =
  | {
      id: string;
      kind: "variables";
      tier: TierName | null;
      variables: NeededVariable[];
      groups: NeededGroup[];
    }
  | { id: string; kind: "confirmation"; finding: string; question: string }
  | { id: string; kind: "unknown" };

export interface CloudJobEvent {
  seq: number;
  time: string | null;
  level: JobEventLevelName;
  phase: JobPhaseName | null;
  message: string;
}

const commands: Partial<Record<JobCommand, JobCommandName>> = {
  [JobCommand.BUILD]: "build",
  [JobCommand.DEPLOY]: "deploy",
  [JobCommand.PREVIEW_UP]: "preview-up",
};

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
};

const levels: Partial<Record<JobEventLevel, JobEventLevelName>> = {
  [JobEventLevel.DEBUG]: "debug",
  [JobEventLevel.INFO]: "info",
  [JobEventLevel.WARN]: "warn",
  [JobEventLevel.ERROR]: "error",
};

const tiers: Partial<Record<Tier, TierName>> = {
  [Tier.PRODUCTION]: "production",
  [Tier.PREVIEW]: "preview",
};

export function cloudJobInputOf(input: JobInput | undefined): CloudJobInput | null {
  if (!input) {
    return null;
  }
  const { need } = input;
  switch (need.case) {
    case "variables":
      return {
        id: input.id,
        kind: "variables",
        tier: tiers[need.value.tier] ?? null,
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

export function cloudJobOf(job: Job): CloudJob {
  return {
    id: job.id,
    projectId: job.projectId,
    command: commands[job.command] ?? null,
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
          deploymentId: job.result.deploymentId,
          builds: job.result.builds.map((build) => ({ app: build.app, buildId: build.buildId })),
        }
      : null,
    sourceId: job.sourceId,
    input: cloudJobInputOf(job.input),
  };
}

export function cloudJobEventOf(event: JobEvent): CloudJobEvent {
  return {
    seq: Number(event.seq),
    time: isoOf(event.time),
    level: levels[event.level] ?? "info",
    phase: phases[event.phase] ?? null,
    message: event.message,
  };
}
