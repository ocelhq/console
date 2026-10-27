"use server";

import { db } from "@console/db";
import type { Tier } from "@console/db/schema";
import {
  exchangeToken,
  mintTierToken,
  recordIssuance,
  removeTarget,
  targetOf,
  tierOf,
} from "@console/targets";
import { type Answer, administering, attempt, done, failed, issuer } from "@/lib/targets";
import { tierOf as tierNamed } from "@/lib/tier";

const TEST_LIFETIME_SECONDS = 60;

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
    const minter = issuer();
    if (!minter) return failed("This console has no issuer key, so it mints no tokens.");
    const { organizationId, userId } = reached.result;
    const target = await targetOf(organizationId, targetId);
    if (!target) return failed("That target is gone.");
    const tier: Tier = tierNamed(tierName);
    const recorded = await tierOf(target.id, tier);
    if (!recorded) return failed(`The target has no ${tier} identity recorded.`);

    const minted = await mintTierToken(await minter, {
      organizationId,
      targetId: target.id,
      tier,
      projectId: "test",
      lifetimeSeconds: TEST_LIFETIME_SECONDS,
    });
    await recordIssuance(db, {
      organizationId,
      projectId: null,
      targetId: target.id,
      tier,
      principal: { kind: "session", userId },
      tokenJti: minted.jti,
      issuedAt: minted.issuedAt,
      expiresAt: minted.expiresAt,
    });
    const exchanged = await exchangeToken({
      vendor: target.vendor,
      identity: { identityProvider: recorded.identityProvider, principal: recorded.principal },
      token: minted.token,
      sessionName: minted.sessionName,
    });
    return exchanged.ok ? { ok: true, result: exchanged.detail } : failed(exchanged.error);
  });
}
