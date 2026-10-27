import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  CISchema,
  type Deployment,
  DeploymentKind,
  type DeploymentService,
  type EnvironmentEvent,
  EnvironmentEventKind,
  TriggerKind,
  TriggerSchema,
} from "@console/connectors/gen/console/v1/deployment_pb";
import { db, type Transaction } from "@console/db";
import type { Job } from "@console/db/schema";
import type { GitRuntime } from "@console/git";
import {
  notifyReported,
  type PlannedJob,
  planReportedJob,
  type ReportedFromCi,
  recordReportedJob,
} from "@console/jobs";
import { uuidv7 } from "uuidv7";
import { deploymentValues, environmentEventValues } from "../../deployments/record";
import {
  projectInOrganization,
  type Recording,
  recordDeployment,
  recordEnvironmentEvent,
} from "../../deployments/report";
import {
  type AdmittedPipeline,
  admitPipeline,
  claimAdmission,
  type PipelineKeys,
  runUrlOf,
} from "../../pipelines/admit";
import { callerOf } from "./caller";

export interface DeploymentServiceDeps {
  notify: (changed: Job) => Promise<void>;
  git: () => GitRuntime | undefined;
  pipelineKeys: () => PipelineKeys;
}

function notOwned(projectId: string): ConnectError {
  return new ConnectError(`No project ${projectId} in the session's organization`, Code.NotFound);
}

function required<T>(record: T | undefined, what: string): T {
  if (!record) {
    throw new ConnectError(`protovalidate let through a request with no ${what}`, Code.Internal);
  }
  return record;
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
  }
}

const previewDeployment = (deployment: Deployment) =>
  deployment.kind === DeploymentKind.PREVIEW_UP && deployment.environment?.tier === Tier.PREVIEW;

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

export function deploymentService(
  deps: DeploymentServiceDeps,
): ServiceImpl<typeof DeploymentService> {
  async function fromPipeline(
    admitted: AdmittedPipeline,
    planned: PlannedJob | undefined,
    record: (tx: Transaction) => Promise<void>,
  ): Promise<void> {
    const made = await db.transaction(async (tx) => {
      await claimAdmission(tx, admitted);
      await record(tx);
      return recordReportedJob(tx, planned);
    });
    await notifyReported(made, deps.notify);
  }

  return {
    async report(request, context) {
      const caller = callerOf(context);
      const reported = required(request.deployment, "deployment");
      if (caller.kind === "session") {
        const values = {
          ...deploymentValues(request.projectId, uuidv7(), reported),
          principal: { kind: "session" as const, userId: caller.session.userId },
        };
        const recording = await recordDeployment(db, values, caller.session.activeOrganizationId);
        if (!recording) {
          throw notOwned(request.projectId);
        }
        accepted(`Deployment ${values.deploymentId}`, recording);
        return {};
      }

      const admitted = await admitPipeline(
        caller.token,
        {
          projectId: request.projectId,
          tier: previewDeployment(reported) ? "preview" : "production",
        },
        deps.pipelineKeys(),
      );
      reported.trigger = create(TriggerSchema, {
        kind: TriggerKind.CI,
        actor: admitted.claims.actor,
      });
      reported.ci = ciOf(admitted);
      const values = {
        ...deploymentValues(request.projectId, uuidv7(), reported),
        principal: principalOf(admitted),
      };
      const planned = await planReportedJob(
        { ...reportedBy(admitted), deployment: values },
        deps.git(),
      );
      await fromPipeline(admitted, planned, async (tx) => {
        const recording = await recordDeployment(tx, values);
        if (!recording) {
          throw notOwned(request.projectId);
        }
        accepted(`Deployment ${values.deploymentId}`, recording);
      });
      return {};
    },

    async recordEnvironmentEvent(request, context) {
      const caller = callerOf(context);
      const event = required(request.event, "event");
      if (caller.kind === "session") {
        const projectId = await projectInOrganization(
          caller.session.activeOrganizationId,
          request.projectId,
        );
        if (!projectId) {
          throw notOwned(request.projectId);
        }
        const values = {
          ...environmentEventValues(projectId, uuidv7(), event),
          principal: { kind: "session" as const, userId: caller.session.userId },
        };
        accepted(
          `Environment event ${values.deploymentId}`,
          await recordEnvironmentEvent(db, values),
        );
        return {};
      }

      const admitted = await admitPipeline(
        caller.token,
        { projectId: request.projectId, tier: previewRemoval(event) ? "preview" : "production" },
        deps.pipelineKeys(),
      );
      event.ci = ciOf(admitted);
      const values = {
        ...environmentEventValues(request.projectId, uuidv7(), event),
        principal: principalOf(admitted),
      };
      const planned = await planReportedJob({ ...reportedBy(admitted), event: values }, deps.git());
      await fromPipeline(admitted, planned, async (tx) => {
        accepted(
          `Environment event ${values.deploymentId}`,
          await recordEnvironmentEvent(tx, values),
        );
      });
      return {};
    },
  };
}
