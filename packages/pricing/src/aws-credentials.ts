import {
  AssumeRoleCommand,
  AssumeRoleWithWebIdentityCommand,
  type Credentials,
  STSClient,
  type STSClientConfig,
} from "@aws-sdk/client-sts";
import { env } from "@console/infra";
import type { Fetch } from "./http";

export const GOOGLE_ID_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
export const ROLE_SESSION_NAME = "ocel-console-pricing";
const STS_REGION = "us-east-1";
const METADATA_TIMEOUT_MS = 5_000;

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
};

export type AwsCredentialsProvider = () => Promise<AwsCredentials>;

export type PricingIdentity = {
  roleArn?: string;
  identity: "auto" | "google" | "aws";
  audience: string;
  accessKey?: { accessKeyId: string; secretAccessKey: string };
};

export type IdentityHost = {
  fetch: Fetch;
  sts: (config: STSClientConfig) => STSClient;
  onCloudRun: boolean;
};

const realHost = (): IdentityHost => ({
  fetch,
  sts: (config) => new STSClient(config),
  onCloudRun: process.env.K_SERVICE !== undefined || process.env.CLOUD_RUN_JOB !== undefined,
});

export function pricingCredentials(
  config: PricingIdentity,
  host: IdentityHost = realHost(),
): AwsCredentialsProvider | undefined {
  const { accessKey, roleArn } = config;
  const base: AwsCredentialsProvider | undefined = accessKey
    ? async () => ({ ...accessKey })
    : undefined;
  if (!roleArn) return base;

  if (config.identity === "google" || (config.identity === "auto" && host.onCloudRun)) {
    const sts = host.sts({ region: STS_REGION });
    return async () => {
      const token = await googleIdToken(host.fetch, config.audience);
      const assumed = await sts.send(
        new AssumeRoleWithWebIdentityCommand({
          RoleArn: roleArn,
          RoleSessionName: ROLE_SESSION_NAME,
          WebIdentityToken: token,
        }),
      );
      return issued(assumed.Credentials, roleArn);
    };
  }

  const sts = host.sts({ region: STS_REGION, ...(base ? { credentials: base } : {}) });
  return async () => {
    const assumed = await sts.send(
      new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: ROLE_SESSION_NAME }),
    );
    return issued(assumed.Credentials, roleArn);
  };
}

async function googleIdToken(fetcher: Fetch, audience: string): Promise<string> {
  const url = `${GOOGLE_ID_TOKEN_URL}?audience=${encodeURIComponent(audience)}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `the GCP metadata server gave no ID token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`the GCP metadata server answered ${response.status} for an ID token`);
  }
  const token = (await response.text()).trim();
  if (!token) throw new Error("the GCP metadata server answered an empty ID token");
  return token;
}

function issued(credentials: Credentials | undefined, roleArn: string): AwsCredentials {
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey) {
    throw new Error(`STS issued no credentials for ${roleArn}`);
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration,
  };
}

export function pricingIdentityFromEnv(): PricingIdentity {
  const key = env.pricingAwsKey;
  return {
    roleArn: env.CONSOLE_PRICING_AWS_ROLE_ARN,
    identity: env.CONSOLE_PRICING_AWS_IDENTITY,
    audience: env.CONSOLE_PRICING_AWS_AUDIENCE,
    accessKey: key
      ? {
          accessKeyId: key.CONSOLE_PRICING_AWS_ACCESS_KEY_ID,
          secretAccessKey: key.CONSOLE_PRICING_AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
  };
}
