import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  CISchema,
  DeploymentKind,
  type DeploymentService,
  EnvironmentEventKind,
  type RecordEnvironmentEventRequest,
  type ReportRequest,
  TriggerKind,
  TriggerSchema,
} from "@console/connectors/gen/console/v1/deployment_pb";
import { db } from "@console/db";
import { environmentEvent, type Job, type Principal } from "@console/db/schema";
import { reportedFromCi } from "@console/jobs";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { environmentEventValues } from "../../deployments/record";
import {
  organizationOfProject,
  projectInOrganization,
  type Recording,
  recordDeployment,
  recordOnce,
} from "../../deployments/report";
import type { ReportTier } from "../../pipelines/admit";
import { type Caller, callerOf, type PipelineReport } from "./caller";

export interface DeploymentServiceDeps {
  notify: (changed: Job) => Promise<void>;
}

type PipelineCaller = Extract<Caller, { kind: "pipeline" }>;

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

const tierOf = (preview: boolean): ReportTier => (preview ? "preview" : "production");

export const reportTier: PipelineReport = (message) => {
  const { projectId, deployment } = message as ReportRequest;
  return {
    projectId,
    tier: tierOf(
      deployment?.kind === DeploymentKind.PREVIEW_UP &&
        deployment.environment?.tier === Tier.PREVIEW,
    ),
  };
};

export const environmentEventTier: PipelineReport = (message) => {
  const { projectId, event } = message as RecordEnvironmentEventRequest;
  return {
    projectId,
    tier: tierOf(
      event?.kind === EnvironmentEventKind.PREVIEW_REMOVED &&
        event.environment?.tier === Tier.PREVIEW,
    ),
  };
};

function principalOf(caller: Caller): Principal {
  return caller.kind === "session"
    ? { kind: "session", userId: caller.session.userId }
    : { kind: "pipeline", pipelineId: caller.pipeline.id, jti: caller.claims.jti };
}

function runUrlOf({ claims }: PipelineCaller): string {
  return `https://github.com/${claims.repository}/actions/runs/${claims.run_id}/attempts/${claims.run_attempt}`;
}

function ciOf(caller: PipelineCaller) {
  return create(CISchema, {
    name: "github-actions",
    repo: caller.claims.repository,
    runUrl: runUrlOf(caller),
    pr: caller.pr ?? 0,
  });
}

async function organizationFor(caller: Caller, projectId: string): Promise<string> {
  if (caller.kind === "session") return caller.session.activeOrganizationId;
  if (caller.pipeline.projectId !== projectId) {
    throw new ConnectError(
      `The pipeline reports to project ${caller.pipeline.projectId}, not ${projectId}`,
      Code.PermissionDenied,
    );
  }
  const organizationId = await organizationOfProject(projectId);
  if (!organizationId) throw new ConnectError(`No project ${projectId}`, Code.NotFound);
  return organizationId;
}

async function ownedProject(context: HandlerContext, projectId: string): Promise<string> {
  const caller = callerOf(context);
  const found = await projectInOrganization(await organizationFor(caller, projectId), projectId);
  if (!found) {
    throw notOwned(projectId);
  }
  return found;
}

function fromPipeline(caller: PipelineCaller) {
  return {
    projectId: caller.pipeline.projectId,
    repositoryId: caller.claims.repository_id,
    runUrl: runUrlOf(caller),
    ...(caller.pr === undefined ? {} : { pr: caller.pr }),
  };
}

export function deploymentService(
  deps: DeploymentServiceDeps,
): ServiceImpl<typeof DeploymentService> {
  return {
    async report(request, context) {
      const caller = callerOf(context);
      const reported = required(request.deployment, "deployment");
      const organizationId = await organizationFor(caller, request.projectId);
      if (caller.kind === "pipeline") {
        reported.trigger = create(TriggerSchema, {
          kind: TriggerKind.CI,
          actor: caller.claims.actor,
        });
        reported.ci = ciOf(caller);
      }
      const recorded = await recordDeployment(
        organizationId,
        request.projectId,
        reported,
        principalOf(caller),
      );
      if (!recorded) {
        throw notOwned(request.projectId);
      }
      accepted(`Deployment ${recorded.values.deploymentId}`, recorded.recording);
      if (caller.kind === "pipeline") {
        await reportedFromCi({ ...fromPipeline(caller), deployment: recorded.values }, deps.notify);
      }
      return {};
    },

    async recordEnvironmentEvent(request, context) {
      const caller = callerOf(context);
      const event = required(request.event, "event");
      const projectId = await ownedProject(context, request.projectId);
      if (caller.kind === "pipeline") {
        event.ci = ciOf(caller);
      }
      const values = {
        ...environmentEventValues(projectId, uuidv7(), event),
        principal: principalOf(caller),
      };
      const recording = await recordOnce(
        values,
        (row) =>
          db
            .insert(environmentEvent)
            .values(row)
            .onConflictDoNothing()
            .returning({ id: environmentEvent.id }),
        async () => {
          const [row] = await db
            .select()
            .from(environmentEvent)
            .where(
              and(
                eq(environmentEvent.projectId, projectId),
                eq(environmentEvent.deploymentId, values.deploymentId),
              ),
            );
          return row;
        },
      );
      accepted(`Environment event ${values.deploymentId}`, recording);
      if (caller.kind === "pipeline") {
        await reportedFromCi({ ...fromPipeline(caller), event: values }, deps.notify);
      }
      return {};
    },
  };
}
