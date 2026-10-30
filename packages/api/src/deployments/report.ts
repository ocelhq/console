import { isDeepStrictEqual } from "node:util";
import { db, type Executor } from "@console/db";
import {
  type Deployment,
  type DeploymentGit,
  type DeploymentTrigger,
  deployment,
  environmentEvent,
  type Principal,
  project,
} from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import type { deploymentValues, environmentEventValues, startValues } from "./record";

export type Recording = "recorded" | "repeated" | "differs" | "gone" | "dispatched";

export interface Reporter {
  principal: Principal;
  organizationId?: string;
  jobId: string | null;
}

type Recorded = {
  id: string;
  createdAt?: Date;
  principal?: Principal | null;
  jobId?: string | null;
  runnerId?: string | null;
};

function contentOf<Row extends Recorded>({
  id: _id,
  createdAt: _createdAt,
  principal: _principal,
  jobId: _jobId,
  runnerId: _runnerId,
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

export type DeploymentValues = ReturnType<typeof deploymentValues>;

export type EnvironmentEventValues = ReturnType<typeof environmentEventValues> & {
  principal: Principal;
};

export type StartValues = ReturnType<typeof startValues>;

export function dispatchedOverrides<
  V extends { trigger: DeploymentTrigger; git: DeploymentGit | null },
>(first: Pick<Deployment, "jobId" | "trigger" | "git">, values: V): V {
  if (first.jobId === null) return values;
  return {
    ...values,
    trigger: first.trigger,
    git: first.git ? { ...values.git, ...first.git } : values.git,
  };
}

type Found = { first: Deployment | null } | undefined;

async function found(
  tx: Executor,
  projectId: string,
  deploymentId: string,
  organizationId: string | undefined,
): Promise<Found> {
  const [row] = await tx
    .select({ first: deployment })
    .from(project)
    .leftJoin(
      deployment,
      and(eq(deployment.projectId, project.id), eq(deployment.deploymentId, deploymentId)),
    )
    .where(
      and(
        eq(project.id, projectId),
        organizationId === undefined ? undefined : eq(project.organizationId, organizationId),
      ),
    );
  return row;
}

export async function recordStart(
  tx: Executor,
  values: StartValues,
  reporter: Reporter,
): Promise<boolean> {
  const stored = await found(tx, values.projectId, values.deploymentId, reporter.organizationId);
  if (!stored) return false;
  const { first } = stored;
  if (!first) {
    await tx
      .insert(deployment)
      .values({ ...values, principal: reporter.principal })
      .onConflictDoNothing();
    return true;
  }
  if (first.jobId === reporter.jobId && first.outcome === null) {
    const { id: _id, ...started } = dispatchedOverrides(first, values);
    await tx
      .update(deployment)
      .set({ ...started, principal: reporter.principal })
      .where(eq(deployment.id, first.id));
  }
  return true;
}

export async function recordDeployment(
  tx: Executor,
  values: DeploymentValues,
  reporter: Reporter,
): Promise<Recording | null> {
  const stored = await found(tx, values.projectId, values.deploymentId, reporter.organizationId);
  if (!stored) return null;
  const { first } = stored;
  const row = { ...values, principal: reporter.principal };
  if (!first) {
    return recordOnce(
      row,
      (inserted) =>
        tx
          .insert(deployment)
          .values(inserted)
          .onConflictDoNothing()
          .returning({ id: deployment.id }),
      async () => {
        const [again] = await tx
          .select()
          .from(deployment)
          .where(
            and(
              eq(deployment.projectId, values.projectId),
              eq(deployment.deploymentId, values.deploymentId),
            ),
          );
        return again;
      },
    );
  }
  if (first.jobId !== reporter.jobId) return "dispatched";
  const { id: _id, ...reported } = dispatchedOverrides(first, row);
  if (first.outcome !== null && first.outcomeBy === "ocel") {
    return compared(first, { id: first.id, ...reported });
  }
  await tx.update(deployment).set(reported).where(eq(deployment.id, first.id));
  return "recorded";
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
