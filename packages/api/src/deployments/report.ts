import { isDeepStrictEqual } from "node:util";
import type { Deployment } from "@console/connectors/gen/console/v1/deployment_pb";
import { db } from "@console/db";
import { deployment, project } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { deploymentValues } from "./record";

export type Recording = "recorded" | "repeated" | "differs" | "gone";

type Recorded = { id: string; createdAt?: Date };

function contentOf<Row extends Recorded>({
  id: _id,
  createdAt: _createdAt,
  ...content
}: Row): unknown {
  return JSON.parse(JSON.stringify(content));
}

export async function recordOnce<Row extends Recorded>(
  values: Row,
  insert: (values: Row) => Promise<unknown[]>,
  stored: () => Promise<Recorded | undefined>,
): Promise<Recording> {
  if ((await insert(values)).length > 0) {
    return "recorded";
  }
  const first = await stored();
  if (!first) {
    return "gone";
  }
  return isDeepStrictEqual(contentOf(first), contentOf(values)) ? "repeated" : "differs";
}

export async function projectInOrganization(
  organizationId: string,
  projectId: string,
): Promise<string | null> {
  const [found] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.organizationId, organizationId), eq(project.id, projectId)));
  return found?.id ?? null;
}

export async function recordDeployment(
  projectId: string,
  reported: Deployment,
): Promise<{ deploymentId: string; recording: Recording }> {
  const values = deploymentValues(projectId, uuidv7(), reported);
  const recording = await recordOnce(
    values,
    (row) =>
      db.insert(deployment).values(row).onConflictDoNothing().returning({ id: deployment.id }),
    async () => {
      const [row] = await db
        .select()
        .from(deployment)
        .where(
          and(
            eq(deployment.projectId, projectId),
            eq(deployment.deploymentId, values.deploymentId),
          ),
        );
      return row;
    },
  );
  return { deploymentId: values.deploymentId, recording };
}
