import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  type CI,
  CISchema,
  type Deployment,
  DeploymentKind,
  type DeploymentService,
  type EnvironmentEvent,
  EnvironmentEventKind,
  type Trigger,
  TriggerKind,
  TriggerSchema,
} from "@console/connectors/gen/console/v1/deployment_pb";
import { db, type Transaction } from "@console/db";
import type { Job, JobKind, Tier as TierName } from "@console/db/schema";
import type { GitRuntime } from "@console/git";
import {
  announce,
  followJob,
  type JobDeps,
  type PlannedJob,
  planReportedJob,
  type ReportedFromCi,
  recordReportedJob,
} from "@console/jobs";
import { uuidv7 } from "uuidv7";
import {
  deploymentValues,
  environmentEventValues,
  startValues,
  tierNamed,
} from "../../deployments/record";
import {
  projectInOrganization,
  type Recording,
  type Reporter,
  recordDeployment,
  recordEnvironmentEvent,
  recordStart,
} from "../../deployments/report";
import { admitJobRecord } from "../../jobs/admit";
import {
  type AdmittedPipeline,
  admitPipeline,
  claimAdmission,
  type PipelineKeys,
  type ReportTier,
  runUrlOf,
} from "../../pipelines/admit";
import { type Caller, callerOf } from "./caller";
import { required } from "./required";

export interface DeploymentServiceDeps {
  jobs: () => JobDeps;
  notify: (changed: Job) => Promise<void>;
  git: () => GitRuntime | undefined;
  pipelineKeys: () => PipelineKeys;
}

function notOwned(projectId: string): ConnectError {
  return new ConnectError(`No project ${projectId} in the session's organization`, Code.NotFound);
}

function accepted(what: string, recording: Recording): void {
  switch (recording) {
    case "gone":
      throw new ConnectError(
        `${what} conflicted with a record that is no longer stored`,
        Code.NotFound,
      );
    case "differs":
      throw new ConnectError(
        `${what} is already recorded with different content`,
        Code.AlreadyExists,
      );
    case "dispatched":
      throw new ConnectError(
        `${what} runs as a job on a runner, and only that job reports it`,
        Code.PermissionDenied,
      );
  }
}

const previewDeployment = (deployment: Pick<Deployment, "kind" | "environment">) =>
  deployment.kind === DeploymentKind.PREVIEW_UP && deployment.environment?.tier === Tier.PREVIEW;

const jobKinds: Partial<Record<DeploymentKind, JobKind>> = {
  [DeploymentKind.DEPLOY]: "deploy",
  [DeploymentKind.PREVIEW_UP]: "preview-up",
};

const eventJobKinds: Partial<Record<EnvironmentEventKind, JobKind>> = {
  [EnvironmentEventKind.PREVIEW_REMOVED]: "preview-rm",
  [EnvironmentEventKind.DESTROYED]: "projects-destroy",
};

function jobKindOf<K extends number>(kinds: Partial<Record<K, JobKind>>, kind: K, what: string) {
  const found = kinds[kind];
  if (!found) {
    throw new ConnectError(`A job records no ${what} of this kind`, Code.PermissionDenied);
  }
  return found;
}

const tierOf = (environment: { tier: Tier } | undefined) =>
  tierNamed(environment?.tier ?? Tier.UNSPECIFIED);

const previewRemoval = (event: EnvironmentEvent) =>
  event.kind === EnvironmentEventKind.PREVIEW_REMOVED && event.environment?.tier === Tier.PREVIEW;

function ciOf(admitted: AdmittedPipeline) {
  return create(CISchema, {
    name: "github-actions",
    repo: admitted.claims.repository,
    runUrl: runUrlOf(admitted.claims),
    pr: admitted.pr ?? 0,
  });
}

function principalOf(admitted: AdmittedPipeline) {
  return {
    kind: "pipeline" as const,
    pipelineId: admitted.pipeline.id,
    jti: admitted.claims.jti,
  };
}

function reportedBy(admitted: AdmittedPipeline): Omit<ReportedFromCi, "deployment" | "event"> {
  return {
    projectId: admitted.pipeline.projectId,
    repositoryId: admitted.claims.repository_id,
    runUrl: runUrlOf(admitted.claims),
    ...(admitted.pr === undefined ? {} : { pr: admitted.pr }),
  };
}

interface Admission {
  projectId: string;
  tier: TierName;
  environmentIdentity: string;
  jobKind: () => JobKind;
  deploymentId?: string;
  starting?: boolean;
  pipelineTier: ReportTier;
}

type Admitted = Reporter & {
  pipeline?: AdmittedPipeline;
  ci?: { trigger: Trigger; ci: CI };
};

function stamped<M extends { trigger?: Trigger; ci?: CI }>(message: M, reporter: Admitted): M {
  return reporter.ci ? { ...message, ...reporter.ci } : message;
}

export function deploymentService(
  deps: DeploymentServiceDeps,
): ServiceImpl<typeof DeploymentService> {
  async function admitted(caller: Caller, admission: Admission): Promise<Admitted> {
    switch (caller.kind) {
      case "session":
        return {
          principal: { kind: "session", userId: caller.session.userId },
          organizationId: caller.session.activeOrganizationId,
          jobId: null,
        };
      case "job": {
        const job = await admitJobRecord(caller.job, {
          projectId: admission.projectId,
          tier: admission.tier,
          environmentIdentity: admission.environmentIdentity,
          kind: admission.jobKind(),
          deploymentId: admission.deploymentId,
          starting: admission.starting,
        });
        return { principal: { kind: "job", jobId: job.id }, jobId: job.id };
      }
      case "pipeline-token": {
        const pipeline = await admitPipeline(
          caller.token,
          { projectId: admission.projectId, tier: admission.pipelineTier },
          deps.pipelineKeys(),
        );
        return {
          principal: principalOf(pipeline),
          jobId: null,
          pipeline,
          ci: {
            trigger: create(TriggerSchema, { kind: TriggerKind.CI, actor: pipeline.claims.actor }),
            ci: ciOf(pipeline),
          },
        };
      }
    }
  }

  async function recorded(
    reporter: Admitted,
    planned: PlannedJob | undefined,
    record: (tx: Transaction) => Promise<void>,
  ): Promise<void> {
    const made = await db.transaction(async (tx) => {
      if (reporter.pipeline) await claimAdmission(tx, reporter.pipeline);
      await record(tx);
      return recordReportedJob(tx, planned);
    });
    await announce(made, deps.notify);
  }

  async function follow(reporter: Admitted, heard: "started" | "reported"): Promise<void> {
    if (reporter.jobId === null) return;
    await followJob(reporter.jobId, deps.jobs(), heard).catch((error: unknown) => {
      console.error("deployments: the job was left for the sweep to follow", {
        id: reporter.jobId,
        error,
      });
    });
  }

  return {
    async start(request, context) {
      const started = required(request.deployment, "deployment");
      const reporter = await admitted(callerOf(context), {
        projectId: request.projectId,
        tier: tierOf(started.environment),
        environmentIdentity: started.environment?.identity ?? "",
        jobKind: () => jobKindOf(jobKinds, started.kind, "deployment"),
        deploymentId: started.id,
        starting: true,
        pipelineTier: previewDeployment(started) ? "preview" : "production",
      });
      const values = startValues(request.projectId, uuidv7(), stamped(started, reporter));
      await recorded(reporter, undefined, async (tx) => {
        if (!(await recordStart(tx, values, reporter))) throw notOwned(request.projectId);
      });
      await follow(reporter, "started");
      return {};
    },

    async report(request, context) {
      const reported = required(request.deployment, "deployment");
      const reporter = await admitted(callerOf(context), {
        projectId: request.projectId,
        tier: tierOf(reported.environment),
        environmentIdentity: reported.environment?.identity ?? "",
        jobKind: () => jobKindOf(jobKinds, reported.kind, "deployment"),
        deploymentId: reported.id,
        pipelineTier: previewDeployment(reported) ? "preview" : "production",
      });
      const values = deploymentValues(request.projectId, uuidv7(), stamped(reported, reporter));
      const planned =
        reporter.pipeline &&
        (await planReportedJob(
          { ...reportedBy(reporter.pipeline), deployment: values },
          deps.git(),
        ));
      await recorded(reporter, planned, async (tx) => {
        const recording = await recordDeployment(tx, values, reporter);
        if (!recording) throw notOwned(request.projectId);
        accepted(`Deployment ${values.deploymentId}`, recording);
      });
      await follow(reporter, "reported");
      return {};
    },

    async recordEnvironmentEvent(request, context) {
      const event = required(request.event, "event");
      const reporter = await admitted(callerOf(context), {
        projectId: request.projectId,
        tier: tierOf(event.environment),
        environmentIdentity: event.environment?.identity ?? "",
        jobKind: () => jobKindOf(eventJobKinds, event.kind, "environment event"),
        pipelineTier: previewRemoval(event) ? "preview" : "production",
      });
      if (reporter.organizationId !== undefined) {
        if (!(await projectInOrganization(reporter.organizationId, request.projectId))) {
          throw notOwned(request.projectId);
        }
      }
      const values = {
        ...environmentEventValues(request.projectId, uuidv7(), {
          ...event,
          ...(reporter.ci && { ci: reporter.ci.ci }),
        }),
        principal: reporter.principal,
      };
      const planned =
        reporter.pipeline &&
        (await planReportedJob({ ...reportedBy(reporter.pipeline), event: values }, deps.git()));
      await recorded(reporter, planned, async (tx) => {
        accepted(
          `Environment event ${values.deploymentId}`,
          await recordEnvironmentEvent(tx, values),
        );
      });
      await follow(reporter, "reported");
      return {};
    },
  };
}
