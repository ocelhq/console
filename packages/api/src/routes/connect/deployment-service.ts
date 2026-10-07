import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import type { DeploymentService } from "@console/connectors/gen/console/v1/deployment_pb";
import { db } from "@console/db";
import { deployment, environmentEvent, project } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { deploymentValues, environmentEventValues } from "./record";
import { organizationKey } from "./session";

async function projectIdOf(organizationId: string | undefined, projectId: string): Promise<string> {
  if (!organizationId) {
    throw new ConnectError("A session is required", Code.Unauthenticated);
  }
  const [found] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.organizationId, organizationId), eq(project.id, projectId)));
  if (!found) {
    throw new ConnectError(`No project ${projectId} in the session's organization`, Code.NotFound);
  }
  return found.id;
}

export const deploymentService: ServiceImpl<typeof DeploymentService> = {
  async report(request, context) {
    const reported = request.deployment;
    if (!reported) {
      throw new ConnectError("protovalidate let through an empty report", Code.Internal);
    }
    const projectId = await projectIdOf(context.values.get(organizationKey), request.projectId);

    await db
      .insert(deployment)
      .values(deploymentValues(projectId, uuidv7(), reported))
      .onConflictDoNothing();
    return {};
  },

  async recordEnvironmentEvent(request, context) {
    const event = request.event;
    if (!event) {
      throw new ConnectError("protovalidate let through an empty event", Code.Internal);
    }
    const projectId = await projectIdOf(context.values.get(organizationKey), request.projectId);

    await db
      .insert(environmentEvent)
      .values(environmentEventValues(projectId, uuidv7(), event))
      .onConflictDoNothing();
    return {};
  },
};
