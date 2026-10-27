import type { Vendor } from "@console/db/schema";
import { describe, expect, it } from "vitest";
import {
  accountProblem,
  audienceOf,
  identityProblem,
  isVendor,
  sessionNameOf,
  subjectPrefixOf,
  unsupportedVendor,
} from "./vendors";

const ISSUER = "https://console.example.com/oidc";
const aws = { vendor: "aws" as const, account: "123456789012" };
const gcp = { vendor: "gcp" as const, account: "shop-prod-4821" };

describe("a target's vendor", () => {
  it("is aws or gcp", () => {
    expect(isVendor("aws")).toBe(true);
    expect(isVendor("azure")).toBe(false);
    expect(unsupportedVendor("azure")).toMatch(/aws or gcp, not azure/);
  });
});

describe("a target's account", () => {
  it.each<[Vendor, string, RegExp | undefined]>([
    ["aws", "123456789012", undefined],
    ["aws", "12345678901", /12 digits/],
    ["gcp", "shop-prod-4821", undefined],
    ["gcp", "123456", /project id/],
  ])("of %s %s", (vendor, account, problem) => {
    const found = accountProblem(vendor, account);
    if (problem === undefined) expect(found).toBeUndefined();
    else expect(found).toMatch(problem);
  });
});

describe("an AWS tier's identity", () => {
  const provider = "arn:aws:iam::123456789012:oidc-provider/console.example.com/oidc";

  it("is the account's OIDC provider for this issuer and a role of the account", () => {
    expect(
      identityProblem(
        aws,
        {
          identityProvider: provider,
          principal: "arn:aws:iam::123456789012:role/ocel/deploy-production",
        },
        ISSUER,
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      "a provider in another account",
      "arn:aws:iam::999999999999:oidc-provider/console.example.com/oidc",
      "arn:aws:iam::123456789012:role/deploy",
      /123456789012/,
    ],
    [
      "a provider for another issuer",
      "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
      "arn:aws:iam::123456789012:role/deploy",
      /console\.example\.com\/oidc/,
    ],
    [
      "a role in another account",
      provider,
      "arn:aws:iam::999999999999:role/deploy",
      /role of account 123456789012/,
    ],
    ["a user, not a role", provider, "arn:aws:iam::123456789012:user/deploy", /role/],
    [
      "a provider in the China partition",
      "arn:aws-cn:iam::123456789012:oidc-provider/console.example.com/oidc",
      "arn:aws:iam::123456789012:role/deploy",
      /aws-cn partition: the console issues credentials only in the aws partition/,
    ],
    [
      "a role in GovCloud",
      provider,
      "arn:aws-us-gov:iam::123456789012:role/deploy",
      /aws-us-gov partition/,
    ],
    ["no ARN", "console.example.com/oidc", "deploy", /OIDC provider ARN/],
  ])("is refused for %s", (_, identityProvider, principal, problem) => {
    expect(identityProblem(aws, { identityProvider, principal }, ISSUER)).toMatch(problem);
  });
});

describe("a GCP tier's identity", () => {
  const provider =
    "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/ocel/providers/console";

  it("is a workload identity provider and a service account of the project", () => {
    expect(
      identityProblem(
        gcp,
        {
          identityProvider: provider,
          principal: "ocel-deploy-preview@shop-prod-4821.iam.gserviceaccount.com",
        },
        ISSUER,
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      "a provider that is no resource name",
      "projects/1/locations/global/workloadIdentityPools/ocel/providers/console",
      "ocel@shop-prod-4821.iam.gserviceaccount.com",
      /workload identity provider/,
    ],
    [
      "a service account of another project",
      provider,
      "ocel@other-project.iam.gserviceaccount.com",
      /service account of project shop-prod-4821/,
    ],
    [
      "a user account",
      provider,
      "someone@example.com",
      /service account of project shop-prod-4821/,
    ],
  ])("is refused for %s", (_, identityProvider, principal, problem) => {
    expect(identityProblem(gcp, { identityProvider, principal }, ISSUER)).toMatch(problem);
  });
});

describe("the names a token carries", () => {
  it("pins the subject to the organization, target, tier and project", () => {
    expect(subjectPrefixOf("org-1", "t-1")).toBe("org:org-1:target:t-1");
    expect(audienceOf("t-1")).toBe("ocel-target:t-1");
  });

  it("names the session after the token, within what AWS takes", () => {
    const name = sessionNameOf("0f8fad5b-d9cb-469f-a165-70867728950e");

    expect(name).toBe("ocel-0f8fad5b-d9c");
    expect(name).toMatch(/^[\w+=,.@-]{2,64}$/);
  });
});
