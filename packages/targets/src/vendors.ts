import type { Tier } from "@console/db/schema";

export const VENDORS = ["aws", "gcp"] as const;
export type Vendor = (typeof VENDORS)[number];

export interface TierIdentity {
  identityProvider: string;
  principal: string;
}

export function isVendor(vendor: string): vendor is Vendor {
  return (VENDORS as readonly string[]).includes(vendor);
}

const AWS_ACCOUNT = /^\d{12}$/;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function accountProblem(vendor: string, account: string): string | undefined {
  if (!isVendor(vendor)) {
    return `the console issues credentials for aws or gcp, not ${vendor}`;
  }
  if (vendor === "aws" && !AWS_ACCOUNT.test(account)) {
    return `an AWS account is 12 digits, not ${account}`;
  }
  if (vendor === "gcp" && !GCP_PROJECT.test(account)) {
    return `a GCP account is a project id, such as shop-prod-4821, not ${account}`;
  }
  return undefined;
}

const AWS_OIDC_PROVIDER = /^arn:aws(?:-cn|-us-gov)?:iam::(\d{12}):oidc-provider\/(\S+)$/;
const AWS_ROLE = /^arn:aws(?:-cn|-us-gov)?:iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*[\w+=,.@-]{1,64}$/;
const GCP_PROVIDER =
  /^\/\/iam\.googleapis\.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;

function escaped(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function awsProblem(
  account: string,
  { identityProvider, principal }: TierIdentity,
  issuer: string,
): string | undefined {
  const provider = AWS_OIDC_PROVIDER.exec(identityProvider);
  if (!provider) {
    return `identity_provider ${identityProvider} is no IAM OIDC provider ARN (arn:aws:iam::<account>:oidc-provider/<host>/<path>)`;
  }
  if (provider[1] !== account) {
    return `identity_provider ${identityProvider} is not in the target's account ${account}`;
  }
  const host = issuer.replace(/^https?:\/\//, "");
  if (provider[2] !== host) {
    return `identity_provider ${identityProvider} trusts ${provider[2]}, not this console's issuer ${host}`;
  }
  const role = AWS_ROLE.exec(principal);
  if (!role || role[1] !== account) {
    return `principal ${principal} is no role of account ${account} (arn:aws:iam::${account}:role/<name>)`;
  }
  return undefined;
}

function gcpProblem(
  project: string,
  { identityProvider, principal }: TierIdentity,
): string | undefined {
  if (!GCP_PROVIDER.test(identityProvider)) {
    return `identity_provider ${identityProvider} is no workload identity provider (//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>)`;
  }
  const serviceAccount = new RegExp(
    `^[a-z](?:[-a-z0-9]{4,28}[a-z0-9])@${escaped(project)}\\.iam\\.gserviceaccount\\.com$`,
  );
  if (!serviceAccount.test(principal)) {
    return `principal ${principal} is no service account of project ${project} (<name>@${project}.iam.gserviceaccount.com)`;
  }
  return undefined;
}

export function identityProblem(
  target: { vendor: string; account: string },
  identity: TierIdentity,
  issuer: string,
): string | undefined {
  switch (target.vendor) {
    case "aws":
      return awsProblem(target.account, identity, issuer);
    case "gcp":
      return gcpProblem(target.account, identity);
    default:
      return `the console issues credentials for aws or gcp, not ${target.vendor}`;
  }
}

export function normalizedGrant(vendor: string, grant: string): string {
  if (vendor !== "aws") return grant;
  const [action = "", ...resource] = grant.split(" ");
  return [action.toLowerCase(), ...resource].join(" ");
}

export function missingGrants(requested: readonly string[], recorded: readonly string[]): string[] {
  const held = new Set(recorded);
  return requested.filter((grant) => !held.has(grant));
}

export function audienceOf(targetId: string): string {
  return `ocel-target:${targetId}`;
}

export function subjectPrefixOf(organizationId: string, targetId: string): string {
  return `org:${organizationId}:target:${targetId}`;
}

export function subjectOf(
  organizationId: string,
  targetId: string,
  tier: Tier,
  projectId: string,
): string {
  return `${subjectPrefixOf(organizationId, targetId)}:tier:${tier}:project:${projectId}`;
}

export function sessionNameOf(jti: string): string {
  return `ocel-${jti.slice(0, 12)}`.replace(/[^\w+=,.@-]/g, "-");
}
