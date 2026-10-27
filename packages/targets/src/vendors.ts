import { VENDORS, type Vendor } from "@console/db/schema";

export interface TierIdentity {
  identityProvider: string;
  principal: string;
}

export function isVendor(vendor: string): vendor is Vendor {
  return (VENDORS as readonly string[]).includes(vendor);
}

const AWS_ACCOUNT = /^\d{12}$/;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function unsupportedVendor(vendor: string): string {
  return `the console issues credentials for ${VENDORS.join(" or ")}, not ${vendor}`;
}

export function accountProblem(vendor: Vendor, account: string): string | undefined {
  switch (vendor) {
    case "aws":
      return AWS_ACCOUNT.test(account) ? undefined : `an AWS account is 12 digits, not ${account}`;
    case "gcp":
      return GCP_PROJECT.test(account)
        ? undefined
        : `a GCP account is a project id, such as shop-prod-4821, not ${account}`;
  }
}

const AWS_PARTITION = /^arn:(aws-[a-z-]+):/;
const AWS_OIDC_PROVIDER = /^arn:aws:iam::(\d{12}):oidc-provider\/(\S+)$/;
const AWS_ROLE = /^arn:aws:iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*[\w+=,.@-]{1,64}$/;
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
  for (const arn of [identityProvider, principal]) {
    const partition = AWS_PARTITION.exec(arn)?.[1];
    if (partition) {
      return `${arn} is in the ${partition} partition: the console issues credentials only in the aws partition`;
    }
  }
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
  target: { vendor: Vendor; account: string },
  identity: TierIdentity,
  issuer: string,
): string | undefined {
  switch (target.vendor) {
    case "aws":
      return awsProblem(target.account, identity, issuer);
    case "gcp":
      return gcpProblem(target.account, identity);
  }
}

export function audienceOf(targetId: string): string {
  return `ocel-target:${targetId}`;
}

export function subjectPrefixOf(organizationId: string, targetId: string): string {
  return `org:${organizationId}:target:${targetId}`;
}

export function sessionNameOf(jti: string): string {
  return `ocel-${jti.slice(0, 12)}`.replace(/[^\w+=,.@-]/g, "-");
}
