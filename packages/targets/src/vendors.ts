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
  const named = `${VENDORS.slice(0, -1).join(", ")} or ${VENDORS.at(-1)}`;
  return `the console issues credentials for ${named}, not ${vendor}`;
}

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IP_ADDRESS = /^[0-9.]+$|:/;

function hostnameProblem(account: string): string | undefined {
  if (IP_ADDRESS.test(account)) {
    return `a VPS account is the box's hostname, not an IP address: ${account} cannot carry the publicly trusted certificate its endpoint serves`;
  }
  return HOSTNAME.test(account)
    ? undefined
    : `a VPS account is the box's fully qualified hostname, such as box.example.com, not ${account}`;
}

export function regionProblem(vendor: Vendor, region: string): string | undefined {
  if (vendor === "vps") {
    return region === "" ? undefined : `a VPS target has no region, so ${region} names nothing`;
  }
  return region === ""
    ? `${vendor === "aws" ? "an AWS" : "a GCP"} target needs a region`
    : undefined;
}

export function accountProblem(vendor: Vendor, account: string): string | undefined {
  switch (vendor) {
    case "aws":
      return AWS_ACCOUNT.test(account) ? undefined : `an AWS account is 12 digits, not ${account}`;
    case "gcp":
      return GCP_PROJECT.test(account)
        ? undefined
        : `a GCP account is a project id, such as shop-prod-4821, not ${account}`;
    case "vps":
      return hostnameProblem(account);
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

function vpsProblem(
  host: string,
  { identityProvider, principal }: TierIdentity,
): string | undefined {
  let url: URL;
  try {
    url = new URL(identityProvider);
  } catch {
    return `identity_provider ${identityProvider} is no https URL of the box's endpoint`;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return `identity_provider ${identityProvider} is no https URL of the box's endpoint`;
  }
  if (url.hostname !== host) {
    return `identity_provider ${identityProvider} is on host ${url.hostname}, not ${host}`;
  }
  if (principal !== "") {
    return `a VPS tier records no principal: the box's own config names the user it signs certificates for, not ${principal}`;
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
    case "vps":
      return vpsProblem(target.account, identity);
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
