import { consoleOrigin } from "@console/auth";
import type { IssuancePrincipal } from "@console/db/schema";
import { configuredIssuer, type IssuanceRow, issuerUrl } from "@console/targets";
import { requireOrganization } from "./access";
import { organizationOf } from "./organization";

export type Answer<T = null> = { ok: true; result: T } | { ok: false; message: string };

export const done = { ok: true, result: null } as const;

export function failed(message: string): Answer<never> {
  return { ok: false, message };
}

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

export async function attempt<T>(run: () => Promise<Answer<T>>): Promise<Answer<T>> {
  try {
    return await run();
  } catch (thrown) {
    return failed(thrown instanceof Error ? thrown.message : String(thrown));
  }
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
  return principal.kind === "pipeline"
    ? { by: "Trusted pipeline", runUrl: principal.runUrl }
    : { by: "Connection test", runUrl: null };
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
