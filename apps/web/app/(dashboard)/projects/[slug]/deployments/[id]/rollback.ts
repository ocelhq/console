"use server";

import { provider } from "@console/connectors";
import { ProviderService } from "@console/connectors/gen/provider/contract/v1/contract_pb";
import { db } from "@console/db";
import { project } from "@console/db/schema";
import { eq } from "drizzle-orm";
import { requireOrganization } from "@/lib/access";
import { endpointFor } from "@/lib/connectors";
import { findDeployment } from "@/lib/deployments";
import { recordRollback, rollbackable } from "@/lib/rollback";
import { viewedProject } from "@/lib/viewed-project";

export type Rolled =
  | { ok: true; id: string }
  | { ok: false; message: string; needsRunner: boolean };

function refused(message: string, needsRunner = false): Rolled {
  return { ok: false, message, needsRunner };
}

export async function rollBackTo(projectId: string, deploymentId: string): Promise<Rolled> {
  const session = await requireOrganization();
  const [organization] = await db
    .select({ id: project.organizationId })
    .from(project)
    .where(eq(project.id, projectId));
  const owned = organization && (await viewedProject(session, { id: projectId }, organization.id));
  const load = owned ? await findDeployment(projectId, deploymentId) : undefined;
  if (!owned || !load || load.error || !load.deployment) {
    return refused("That deployment isn’t in this organization.");
  }
  const from = load.deployment;
  if (!rollbackable(from, load.active)) {
    return refused(
      "Only a production promotion that succeeded, and is not live, can be rolled back to.",
    );
  }
  const reach = await endpointFor(owned.viewer, from.target);
  if (!reach?.serves(ProviderService.method.rollback)) {
    return refused("No endpoint the console can reach rolls back this target.", true);
  }
  const answer = await provider.rollback(
    reach.endpoint,
    owned.slug,
    from.promotionId,
    from.edgeKind,
  );
  if (!answer.done) {
    await reach.denied("rollback", answer.refusal);
    return refused(answer.refusal.message, answer.refusal.reason === "needs-runner");
  }
  return { ok: true, id: await recordRollback(from, answer.result, session.userId) };
}
