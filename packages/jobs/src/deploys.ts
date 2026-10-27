import { db } from "@console/db";
import { type Job, job, projectRepo, trustedPipeline } from "@console/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { changed } from "./queue";

export type DeployIn =
  | { mode: "runners" }
  | {
      mode: "ci";
      pipeline: {
        repository: string;
        repositoryId: string;
        repositoryOwnerId: string;
        createdBy: string | null;
      };
    };

export async function deployIn(
  projectId: string,
  where: DeployIn,
  notify: (changed: Job) => Promise<void>,
): Promise<void> {
  const canceled = await db.transaction(async (tx) => {
    const [linked] = await tx
      .update(projectRepo)
      .set({ deploys: where.mode })
      .where(eq(projectRepo.projectId, projectId))
      .returning({ projectId: projectRepo.projectId });
    if (!linked) throw new Error("the project is not linked to a repository");

    await tx
      .delete(trustedPipeline)
      .where(and(eq(trustedPipeline.projectId, projectId), eq(trustedPipeline.origin, "linked")));
    if (where.mode === "runners") return [];

    await tx.insert(trustedPipeline).values({
      id: crypto.randomUUID(),
      projectId,
      kind: "github-actions",
      origin: "linked",
      ...where.pipeline,
    });
    return tx
      .update(job)
      .set({ status: "canceled", finishedAt: sql`now()`, ...changed() })
      .where(and(eq(job.projectId, projectId), eq(job.status, "queued")))
      .returning();
  });
  for (const row of canceled) {
    await notify(row).catch((error: unknown) => {
      console.error("jobs: a canceled job went unreported until resync", { id: row.id, error });
    });
  }
}
