"use server";

import { db } from "@console/db";
import { project, projectRepo, trustedPipeline } from "@console/db/schema";
import { grantCredentials } from "@console/git";
import { bindProject, targetOf, unbindProject } from "@console/targets";
import { and, eq } from "drizzle-orm";
import { credentialGrantOf, type GrantInput } from "@/lib/credential-grant";
import { type Answer, administering, attempt, done, failed } from "@/lib/targets";
import { tierOf } from "@/lib/tier";

async function ownedProject(organizationId: string, projectId: string): Promise<boolean> {
  const [found] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.organizationId, organizationId), eq(project.id, projectId)));
  return found !== undefined;
}

export async function bindProjectTier(
  projectId: string,
  tierName: string,
  targetId: string,
): Promise<Answer> {
  return attempt(async () => {
    const reached = await administering();
    if (!reached.ok) return reached;
    const { organizationId } = reached.result;
    if (!(await ownedProject(organizationId, projectId))) {
      return failed("That project isn’t in this organization.");
    }
    const tier = tierOf(tierName);
    if (!targetId) {
      await unbindProject(projectId, tier);
      return done;
    }
    if (!(await targetOf(organizationId, targetId))) {
      return failed("That target isn’t this organization’s.");
    }
    await bindProject(db, { projectId, tier, targetId });
    return done;
  });
}

export async function grantPipelineCredentials(
  projectId: string,
  pipelineId: string,
  input: GrantInput,
): Promise<Answer> {
  return attempt(async () => {
    const reached = await administering();
    if (!reached.ok) return reached;
    if (!(await ownedProject(reached.result.organizationId, projectId))) {
      return failed("That project isn’t in this organization.");
    }
    const [pipeline] = await db
      .select({ origin: trustedPipeline.origin, productionBranch: projectRepo.productionBranch })
      .from(trustedPipeline)
      .leftJoin(projectRepo, eq(projectRepo.projectId, trustedPipeline.projectId))
      .where(and(eq(trustedPipeline.projectId, projectId), eq(trustedPipeline.id, pipelineId)));
    if (!pipeline) return failed("That pipeline is gone.");
    const answer = credentialGrantOf(
      input,
      pipeline.origin === "linked" ? (pipeline.productionBranch ?? undefined) : undefined,
    );
    if (!answer.ok) return failed(answer.message);
    if (!(await grantCredentials(projectId, pipelineId, answer.grant))) {
      return failed("That pipeline is gone.");
    }
    return done;
  });
}
