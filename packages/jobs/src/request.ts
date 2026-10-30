import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { leastRoleOf, type Role } from "@console/connectors";
import { Tier as WireTier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  JobCommand,
  JobCommandSchema,
  type JobRequest,
  JobRequestSchema,
  JobState,
  type Job as RunnerJob,
} from "@console/connectors/gen/runner/v1/runner_pb";
import type { Job, JobKind, JobSpec, JobStatus, Tier } from "@console/db/schema";

export const COMMANDS: Record<JobKind, JobCommand> = {
  build: JobCommand.BUILD,
  deploy: JobCommand.DEPLOY,
  "preview-up": JobCommand.PREVIEW_UP,
  "preview-rm": JobCommand.PREVIEW_RM,
  "projects-destroy": JobCommand.PROJECTS_DESTROY,
};

export function leastRoleOfKind(kind: JobKind): Role | undefined {
  return leastRoleOf(JobCommandSchema.value[COMMANDS[kind]]);
}

export const KINDS = Object.fromEntries(
  Object.entries(COMMANDS).map(([kind, command]) => [command, kind]),
) as Partial<Record<JobCommand, JobKind>>;

export const WIRE_TIERS: Record<Tier, WireTier> = {
  production: WireTier.PRODUCTION,
  preview: WireTier.PREVIEW,
};

export const TIERS: Partial<Record<WireTier, Tier>> = {
  [WireTier.PRODUCTION]: "production",
  [WireTier.PREVIEW]: "preview",
};

export type DeployingKind = Extract<JobKind, "deploy" | "preview-up">;

export function deploys(kind: JobKind): kind is DeployingKind {
  return kind === "deploy" || kind === "preview-up";
}

export function requestOf(row: Pick<Job, "kind">, spec: JobSpec, gitToken?: string): JobRequest {
  const source =
    "sourceId" in spec.source
      ? { case: "sourceId" as const, value: spec.source.sourceId }
      : {
          case: "gitSource" as const,
          value: {
            cloneUrl: spec.source.git.cloneUrl,
            commit: spec.source.git.commit,
            token: gitToken ?? "",
          },
        };
  return create(JobRequestSchema, {
    command: COMMANDS[row.kind],
    source,
    git: spec.git && {
      commit: spec.git.commit ?? "",
      branch: spec.git.branch ?? "",
      dirty: spec.git.dirty,
      pullRequest: spec.git.pullRequest ?? 0,
    },
    tag: spec.tag ?? "",
    preview: spec.preview && {
      name: spec.preview.name,
      persistent: spec.preview.persistent,
      label: spec.preview.label ?? "",
    },
    projectPath: spec.projectPath ?? "",
    configFile: spec.configFile ?? "",
    tierValues: spec.tierValues ?? false,
  });
}

export function uploadedSpecOf(request: JobRequest): JobSpec | undefined {
  if (request.source.case !== "sourceId") return undefined;
  return {
    source: { sourceId: request.source.value },
    ...(request.git && {
      git: {
        ...(request.git.commit ? { commit: request.git.commit } : {}),
        ...(request.git.branch ? { branch: request.git.branch } : {}),
        dirty: request.git.dirty,
        ...(request.git.pullRequest ? { pullRequest: request.git.pullRequest } : {}),
      },
    }),
    ...(request.tag ? { tag: request.tag } : {}),
    ...(request.preview && {
      preview: {
        name: request.preview.name,
        persistent: request.preview.persistent,
        ...(request.preview.label ? { label: request.preview.label } : {}),
      },
    }),
    ...(request.projectPath ? { projectPath: request.projectPath } : {}),
    ...(request.configFile ? { configFile: request.configFile } : {}),
    ...(request.tierValues ? { tierValues: true as const } : {}),
  };
}

export const STATUSES: Partial<Record<JobState, JobStatus>> = {
  [JobState.QUEUED]: "queued",
  [JobState.RUNNING]: "running",
  [JobState.INPUT_REQUIRED]: "input-required",
  [JobState.SUCCEEDED]: "done",
  [JobState.FAILED]: "failed",
  [JobState.CANCELED]: "canceled",
};

export const WIRE_STATES: Record<JobStatus, JobState> = {
  queued: JobState.QUEUED,
  running: JobState.RUNNING,
  "input-required": JobState.INPUT_REQUIRED,
  done: JobState.SUCCEEDED,
  failed: JobState.FAILED,
  canceled: JobState.CANCELED,
};

const RANKS: Record<JobStatus, number> = {
  queued: 0,
  running: 1,
  "input-required": 1,
  done: 2,
  failed: 2,
  canceled: 2,
};

export function isTerminal(status: JobStatus): boolean {
  return RANKS[status] === 2;
}

export function moves(from: JobStatus, to: JobStatus): boolean {
  return from !== to && (RANKS[to] > RANKS[from] || (RANKS[to] === 1 && RANKS[from] === 1));
}

export interface RunnerView {
  status: JobStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  error: string | null;
}

export function viewOf(job: RunnerJob): RunnerView | undefined {
  const status = STATUSES[job.state];
  if (!status) return undefined;
  return {
    status,
    startedAt: job.startedAt ? timestampDate(job.startedAt) : null,
    endedAt: job.endedAt ? timestampDate(job.endedAt) : null,
    error: job.error ? job.error.message || job.error.code : null,
  };
}
