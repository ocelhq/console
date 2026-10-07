import { isDeepStrictEqual } from "node:util";
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

type Recorded = { id: string; createdAt?: Date };

function contentOf<Row extends Recorded>({
  id: _id,
  createdAt: _createdAt,
  ...content
}: Row): unknown {
  return JSON.parse(JSON.stringify(content));
}

async function recordOnce<Row extends Recorded>(
  what: string,
  values: Row,
  insert: (values: Row) => Promise<unknown[]>,
  stored: () => Promise<Recorded | undefined>,
): Promise<void> {
  if ((await insert(values)).length > 0) {
    return;
  }
  const first = await stored();
  if (!first) {
    throw new ConnectError(
      `${what} conflicted with a record that is no longer stored`,
      Code.NotFound,
    );
  }
  if (!isDeepStrictEqual(contentOf(first), contentOf(values))) {
    throw new ConnectError(
      `${what} is already recorded with different content`,
      Code.AlreadyExists,
    );
  }
}

export const deploymentService: ServiceImpl<typeof DeploymentService> = {
  async report(request, context) {
    const reported = required(request.deployment, "deployment");
    const projectId = await ownedProject(context, request.projectId);
    const values = deploymentValues(projectId, uuidv7(), reported);
    await recordOnce(
      `Deployment ${values.runId}`,
      values,
      (row) =>
        db.insert(deployment).values(row).onConflictDoNothing().returning({ id: deployment.id }),
      async () => {
        const [row] = await db
          .select()
          .from(deployment)
          .where(and(eq(deployment.projectId, projectId), eq(deployment.runId, values.runId)));
        return row;
      },
    );
    return {};
  },

  async recordEnvironmentEvent(request, context) {
    const event = required(request.event, "event");
    const projectId = await ownedProject(context, request.projectId);
    const values = environmentEventValues(projectId, uuidv7(), event);
    await recordOnce(
      `Environment event ${values.runId}`,
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
              eq(environmentEvent.runId, values.runId),
            ),
          );
        return row;
      },
    );
    return {};
  },
};
