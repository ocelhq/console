import { db } from "@console/db";
import { type DeployMode, job, projectRepo } from "@console/db/schema";
import { syncLinkedPipeline } from "@console/git";
import { and, eq } from "drizzle-orm";
import { type JobDeps, nowOf } from "./deps";
import { isFromGit } from "./state";
import { followCancels, stopJobs } from "./stop";

export async function deployIn(
  projectId: string,
  where: { mode: DeployMode; by: string | null },
  deps: JobDeps,
): Promise<void> {
  const now = nowOf(deps);
  const stopped = await db.transaction(async (tx) => {
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
    return stopJobs(tx, and(eq(job.projectId, projectId), isFromGit), now);
  });
  await followCancels(stopped, deps);
}
