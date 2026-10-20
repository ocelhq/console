import { env } from "@console/infra/env";

export interface CloudOffer {
  apiUrl: string;
  providerUrl: string;
  audience: string;
}

export function readCloudOffer(): CloudOffer | undefined {
  const cloud = env.ocelCloud;
  if (!cloud) {
    return undefined;
  }
  return {
    apiUrl: cloud.CONSOLE_CLOUD_URL,
    providerUrl: cloud.CONSOLE_CLOUD_PROVIDER_URL ?? "",
    audience: cloud.CONSOLE_CLOUD_AUDIENCE ?? new URL(cloud.CONSOLE_CLOUD_URL).origin,
  };
}
