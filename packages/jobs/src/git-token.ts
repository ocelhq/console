import { db } from "@console/db";
import { gitInstallation, projectRepo } from "@console/db/schema";
import type { GitRuntime } from "@console/git";
import { eq } from "drizzle-orm";
import type { GitToken } from "./deps";

export const noGitToken: GitToken = async () => {
  throw new Error("Git integrations are not configured: set CONSOLE_ENCRYPTION_KEY");
};

export function gitTokens(git: () => GitRuntime | undefined): GitToken {
  return async (projectId) => {
    const runtime = git();
    if (!runtime) return noGitToken(projectId);
    const [linked] = await db
      .select({
        repoId: projectRepo.repoId,
        fullName: projectRepo.fullName,
        externalId: gitInstallation.externalId,
        gitAppId: gitInstallation.gitAppId,
      })
      .from(projectRepo)
      .innerJoin(gitInstallation, eq(gitInstallation.id, projectRepo.installationId))
      .where(eq(projectRepo.projectId, projectId));
    if (!linked) throw new Error("the project is no longer linked to a repository");
    const app = await runtime.store.loadApp(linked.gitAppId);
    if (!app) throw new Error("the project's GitHub App is gone");
    const { token } = await runtime
      .providerFor(app)
      .repoToken(
        { externalId: linked.externalId },
        { id: linked.repoId, fullName: linked.fullName },
        "read",
      );
    return token;
  };
}
