"use server";

import { db } from "@console/db";
import {
  exchangeToken,
  issue,
  removeTarget,
  TEST_LIFETIME_SECONDS,
  targetOf,
  tierOf,
} from "@console/targets";
import { type Answer, attempt, done, failed } from "@/lib/answer";
import { administering, issuer } from "@/lib/targets";
import { parseTier } from "@/lib/tier";

export async function removeOrganizationTarget(targetId: string): Promise<Answer> {
  return attempt(async () => {
    const reached = await administering();
    if (!reached.ok) return reached;
    if (!(await removeTarget(reached.result.organizationId, targetId))) {
      return failed("That target is already gone.");
    }
    return done;
  });
}

export async function testConnection(targetId: string, tierName: string): Promise<Answer<string>> {
  return attempt(async () => {
    const reached = await administering();
    if (!reached.ok) return reached;
    const tier = parseTier(tierName);
    if (!tier) return failed("A tier is production or preview.");
    const minter = issuer();
    if (!minter) return failed("This console has no issuer key, so it mints no tokens.");
    const { organizationId, userId } = reached.result;
    const target = await targetOf(organizationId, targetId);
    if (!target) return failed("That target isn’t this organization’s.");
    const recorded = await tierOf(target.id, tier);
    if (!recorded) return failed(`The target has no ${tier} identity recorded.`);

    const signer = await minter;
    const issued = await db.transaction((tx) =>
      issue(tx, signer, {
        target,
        tier,
        lifetimeSeconds: TEST_LIFETIME_SECONDS,
        purpose: "test",
        principal: { kind: "session", userId },
      }),
    );
    const exchanged = await exchangeToken({
      vendor: target.vendor,
      identity: { identityProvider: recorded.identityProvider, principal: recorded.principal },
      token: issued.token,
      sessionName: issued.sessionName,
    });
    return exchanged.ok ? { ok: true, result: exchanged.detail } : failed(exchanged.error);
  });
}
