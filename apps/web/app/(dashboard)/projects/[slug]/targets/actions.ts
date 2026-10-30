"use server";

import { bindRunner, unbindRunner } from "@console/api";
import { db } from "@console/db";
import { grantCredentials } from "@console/git";
import { bindProject, projectInOrganization, targetOf, unbindProject } from "@console/targets";
import { type Answer, attempt, done, failed } from "@/lib/answer";
import { credentialGrantOf, type GrantInput } from "@/lib/credential-grant";
import { administering } from "@/lib/targets";
import { parseTier } from "@/lib/tier";

const NOT_OURS = "That project isn’t in this organization.";

export async function bindProjectTier(
  projectId: string,
  tierName: string,
  targetId: string,
): Promise<Answer> {
  return attempt(async () => {
    const reached = await administering();
    if (!reached.ok) return reached;
    const tier = parseTier(tierName);
    if (!tier) return failed("A tier is production or preview.");
    const { organizationId } = reached.result;
    if (!(await projectInOrganization(organizationId, projectId))) return failed(NOT_OURS);
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
    if (!(await projectInOrganization(reached.result.organizationId, projectId))) {
      return failed(NOT_OURS);
    }
    const answer = credentialGrantOf(input);
    if (!answer.ok) return failed(answer.message);
    if (!(await grantCredentials(projectId, pipelineId, answer.grant))) {
      return failed("That pipeline is gone.");
    }
    return done;
  });
}

export async function bindProjectRunner(
  projectId: string,
  tierName: string,
  runnerId: string,
  credentials: boolean,
): Promise<Answer> {
  return attempt(async () => {
    const reached = await administering();
    if (!reached.ok) return reached;
    const tier = parseTier(tierName);
    if (!tier) return failed("A tier is production or preview.");
    const { organizationId } = reached.result;
    const answer = runnerId
      ? await bindRunner(organizationId, { projectId, tier, runnerId, credentials })
      : await unbindRunner(organizationId, projectId, tier);
    return answer.ok ? done : failed(answer.message);
  });
}
