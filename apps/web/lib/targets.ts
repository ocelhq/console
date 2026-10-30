import { consoleOrigin } from "@console/auth";
import type { IssuancePrincipal } from "@console/db/schema";
import { configuredIssuer, type IssuanceRow, issuerUrl } from "@console/targets";
import { requireOrganization } from "./access";
import { type Answer, failed } from "./answer";
import { organizationOf } from "./organization";

export function issuer() {
  return configuredIssuer(consoleOrigin());
}

export function issuerAddress(): string {
  return issuerUrl(consoleOrigin());
}

export async function administering(): Promise<Answer<{ userId: string; organizationId: string }>> {
  const session = await requireOrganization();
  const organization = await organizationOf(session.userId, session.activeOrganizationId);
  if (!organization?.administers) {
    return failed("Only owners and admins can change the organization’s targets.");
  }
  return {
    ok: true,
    result: { userId: session.userId, organizationId: session.activeOrganizationId },
  };
}

export type IssuanceView = {
  id: string;
  project: string | null;
  target: string;
  tier: string;
  by: string;
  runUrl: string | null;
  issuedAt: string;
  expiresAt: string;
};

function byWhom(principal: IssuancePrincipal): { by: string; runUrl: string | null } {
  switch (principal.kind) {
    case "pipeline":
      return { by: "Trusted pipeline", runUrl: principal.runUrl };
    case "session":
      return { by: "Connection test", runUrl: null };
  }
}

export function issuanceView(row: IssuanceRow): IssuanceView {
  return {
    id: row.id,
    project: row.projectSlug ?? row.projectId,
    target: row.vendor ? `${row.vendor} ${row.account} ${row.region}` : `removed (${row.targetId})`,
    tier: row.tier,
    ...byWhom(row.principal),
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export function removalWarning(target: {
  vendor: string;
  account: string;
  region: string;
  tiers: { tier: string }[];
  bound: string[];
}): string {
  const place = [target.vendor, target.account, target.region].filter(Boolean).join(" ");
  const tiers =
    target.tiers.length === 0
      ? "It has no recorded tier."
      : `The console forgets its ${target.tiers.map((tier) => tier.tier).join(" and ")} identity and stops issuing credentials for it.`;
  const projects =
    target.bound.length === 0
      ? "No project deploys to it."
      : `These stop deploying to it until they bind another target: ${target.bound.join(", ")}.`;
  return `Removes ${place} from this console. ${tiers} ${projects} The account keeps trusting the issuer until an admin runs ocel bootstrap --remove there.`;
}
