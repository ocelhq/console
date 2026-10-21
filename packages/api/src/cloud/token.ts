import { signOrganizationToken } from "@console/auth";
import type { CloudOffer } from "../routes/connect/cloud";
import type { CloudCaller } from "./caller";

export const CLOUD_SCOPES = ["cloud.apps.read", "cloud.apps.write"] as const;

export type CloudScope = (typeof CLOUD_SCOPES)[number];

export interface CloudToken {
  token: string;
  expiresAt: Date;
}

export function signCloudToken(
  cloud: CloudOffer,
  caller: Pick<CloudCaller, "userId" | "organizationId">,
  scope: readonly CloudScope[],
  lifetimeSeconds: number,
): Promise<CloudToken> {
  return signOrganizationToken({
    audience: cloud.audience,
    organizationId: caller.organizationId,
    userId: caller.userId,
    scope,
    lifetimeSeconds,
  });
}
