import { db } from "@console/db";
import { type DeployMode, type Job, job, projectRepo } from "@console/db/schema";
import { syncLinkedPipeline } from "@console/git";
import { and, eq, sql } from "drizzle-orm";
import { changed } from "./queue";

export async function deployIn(
  projectId: string,
  where: { mode: DeployMode; by: string | null },
  notify: (changed: Job) => Promise<void>,
): Promise<void> {
  const canceled = await db.transaction(async (tx) => {
    const [linked] = await tx
      .update(projectRepo)
      .set({ deploys: where.mode })
      .where(eq(projectRepo.projectId, projectId))
      .returning({ repoOwnerId: projectRepo.repoOwnerId });
    if (!linked) throw new Error("the project is not linked to a repository");
    if (where.mode === "ci" && linked.repoOwnerId === null) {
      throw new Error("link the repository again so the console learns who owns it");
    }
    await syncLinkedPipeline(tx, projectId, where.by);
    if (where.mode === "runners") return [];
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
