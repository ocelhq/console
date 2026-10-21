import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type { DeploymentService } from "@console/connectors/gen/console/v1/deployment_pb";
import { db } from "@console/db";
import { environmentEvent } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { environmentEventValues } from "../../deployments/record";
import {
  projectInOrganization,
  type Recording,
  recordDeployment,
  recordOnce,
} from "../../deployments/report";
import { sessionOf } from "./session";

function notOwned(projectId: string): ConnectError {
  return new ConnectError(`No project ${projectId} in the session's organization`, Code.NotFound);
}

async function ownedProject(context: HandlerContext, projectId: string): Promise<string> {
  const found = await projectInOrganization(sessionOf(context).activeOrganizationId, projectId);
  if (!found) {
    throw notOwned(projectId);
  }
  return found;
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

export const deploymentService: ServiceImpl<typeof DeploymentService> = {
  async report(request, context) {
    const reported = required(request.deployment, "deployment");
    const recorded = await recordDeployment(
      sessionOf(context).activeOrganizationId,
      request.projectId,
      reported,
    );
    if (!recorded) {
      throw notOwned(request.projectId);
    }
    accepted(`Deployment ${recorded.deploymentId}`, recorded.recording);
    return {};
  },

  async recordEnvironmentEvent(request, context) {
    const event = required(request.event, "event");
    const projectId = await ownedProject(context, request.projectId);
    const values = environmentEventValues(projectId, uuidv7(), event);
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
    return {};
  },
};
