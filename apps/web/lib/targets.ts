import { consoleOrigin } from "@console/auth";
import type { IssuancePrincipal } from "@console/db/schema";
import { configuredIssuer, type IssuanceRow, issuerUrl } from "@console/targets";
import { requireOrganization } from "./access";
import { type Answer, failed } from "./answer";
import { organizationOf } from "./organization";
import { targetLabel } from "./target-text";

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
    case "job":
      return { by: `Job on ${principal.runner}`, runUrl: null };
  }
}

export function issuanceView(row: IssuanceRow): IssuanceView {
  return {
    id: row.id,
    project: row.projectSlug ?? row.projectId,
    target:
      row.vendor && row.account !== null && row.region !== null
        ? targetLabel({
            vendor: row.vendor,
            account: row.account,
            region: row.region,
            namespace: row.namespace ?? "",
          })
        : `removed (${row.targetId})`,
    tier: row.tier,
    ...byWhom(row.principal),
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
