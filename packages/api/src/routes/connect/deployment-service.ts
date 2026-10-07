import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type { DeploymentService } from "@console/connectors/gen/console/v1/deployment_pb";
import { db } from "@console/db";
import { deployment, environmentEvent, project } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { deploymentValues, environmentEventValues } from "./record";
import { organizationOf } from "./session";

async function ownedProject(context: HandlerContext, projectId: string): Promise<string> {
  const [found] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.organizationId, organizationOf(context)), eq(project.id, projectId)));
  if (!found) {
    throw new ConnectError(`No project ${projectId} in the session's organization`, Code.NotFound);
  }
  return found.id;
}

function required<T>(record: T | undefined, what: string): T {
  if (!record) {
    throw new ConnectError(`protovalidate let through a request with no ${what}`, Code.Internal);
  }
  return record;
}

export const deploymentService: ServiceImpl<typeof DeploymentService> = {
  async report(request, context) {
    const reported = required(request.deployment, "deployment");
    const projectId = await ownedProject(context, request.projectId);
    await db
      .insert(deployment)
      .values(deploymentValues(projectId, uuidv7(), reported))
      .onConflictDoNothing();
    return {};
  },

  async recordEnvironmentEvent(request, context) {
    const event = required(request.event, "event");
    const projectId = await ownedProject(context, request.projectId);
    await db
      .insert(environmentEvent)
      .values(environmentEventValues(projectId, uuidv7(), event))
      .onConflictDoNothing();
    return {};
  },
};
