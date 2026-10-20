import { type ActiveOrganizationSession, signOrganizationToken } from "@console/auth";
import type { CloudOffer } from "../routes/connect/cloud";

export const CLOUD_SCOPES = ["cloud.apps.read", "cloud.apps.write"] as const;

export type CloudScope = (typeof CLOUD_SCOPES)[number];

export interface CloudToken {
  token: string;
  expiresAt: Date;
}

export function signCloudToken(
  cloud: CloudOffer,
  session: ActiveOrganizationSession,
  scope: readonly CloudScope[],
  lifetimeSeconds: number,
): Promise<CloudToken> {
  return signOrganizationToken({
    audience: cloud.audience,
    organizationId: session.activeOrganizationId,
    userId: session.userId,
    scope,
    lifetimeSeconds,
  });
}
