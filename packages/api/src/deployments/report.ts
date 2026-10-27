import { isDeepStrictEqual } from "node:util";
import { db, type Executor } from "@console/db";
import { deployment, environmentEvent, type Principal, project } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import type { deploymentValues, environmentEventValues } from "./record";

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

export type DeploymentValues = ReturnType<typeof deploymentValues> & { principal: Principal };

export type EnvironmentEventValues = ReturnType<typeof environmentEventValues> & {
  principal: Principal;
};

export async function recordDeployment(
  tx: Executor,
  values: DeploymentValues,
  organizationId?: string,
): Promise<Recording | null> {
  const stored = and(
    eq(deployment.projectId, values.projectId),
    eq(deployment.deploymentId, values.deploymentId),
  );
  const [found] = await tx
    .select({ first: deployment })
    .from(project)
    .leftJoin(deployment, stored)
    .where(
      and(
        eq(project.id, values.projectId),
        organizationId === undefined ? undefined : eq(project.organizationId, organizationId),
      ),
    );
  if (!found) {
    return null;
  }
  if (found.first) {
    return compared(found.first, values);
  }
  return recordOnce(
    values,
    (row) =>
      tx.insert(deployment).values(row).onConflictDoNothing().returning({ id: deployment.id }),
    async () => {
      const [row] = await tx.select().from(deployment).where(stored);
      return row;
    },
  );
}

export async function recordEnvironmentEvent(
  tx: Executor,
  values: EnvironmentEventValues,
): Promise<Recording> {
  return recordOnce(
    values,
    (row) =>
      tx
        .insert(environmentEvent)
        .values(row)
        .onConflictDoNothing()
        .returning({ id: environmentEvent.id }),
    async () => {
      const [row] = await tx
        .select()
        .from(environmentEvent)
        .where(
          and(
            eq(environmentEvent.projectId, values.projectId),
            eq(environmentEvent.deploymentId, values.deploymentId),
          ),
        );
      return row;
    },
  );
}
