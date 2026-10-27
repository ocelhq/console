import { isDeepStrictEqual } from "node:util";
import type { Deployment } from "@console/connectors/gen/console/v1/deployment_pb";
import { db } from "@console/db";
import { deployment, type Principal, project } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { deploymentValues } from "./record";

export type Recording = "recorded" | "repeated" | "differs" | "gone";

type Recorded = { id: string; createdAt?: Date; principal?: Principal | null };

function contentOf<Row extends Recorded>({
  id: _id,
  createdAt: _createdAt,
  principal: _principal,
  ...content
}: Row): unknown {
  return JSON.parse(JSON.stringify(content));
}

function compared(first: Recorded, values: Recorded): Recording {
  return isDeepStrictEqual(contentOf(first), contentOf(values)) ? "repeated" : "differs";
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
  return first ? compared(first, values) : "gone";
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

export async function organizationOfProject(projectId: string): Promise<string | null> {
  const [found] = await db
    .select({ organizationId: project.organizationId })
    .from(project)
    .where(eq(project.id, projectId));
  return found?.organizationId ?? null;
}

export type DeploymentValues = ReturnType<typeof deploymentValues> & { principal: Principal };

export async function recordDeployment(
  organizationId: string,
  projectId: string,
  reported: Deployment,
  principal: Principal,
): Promise<{ values: DeploymentValues; recording: Recording } | null> {
  const stored = and(eq(deployment.projectId, projectId), eq(deployment.deploymentId, reported.id));
  const [found] = await db
    .select({ first: deployment })
    .from(project)
    .leftJoin(deployment, stored)
    .where(and(eq(project.organizationId, organizationId), eq(project.id, projectId)));
  if (!found) {
    return null;
  }
  const values = { ...deploymentValues(projectId, uuidv7(), reported), principal };
  const recording = found.first
    ? compared(found.first, values)
    : await recordOnce(
        values,
        (row) =>
          db.insert(deployment).values(row).onConflictDoNothing().returning({ id: deployment.id }),
        async () => {
          const [row] = await db.select().from(deployment).where(stored);
          return row;
        },
      );
  return { values, recording };
}
