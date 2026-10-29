import { defineEnv, group } from "ocel/env";
import { z } from "zod";

export const env = defineEnv({
  BETTER_AUTH_SECRET: {
    class: "secret",
    description: "Signs sessions and the tokens the console hands the CLI and connectors.",
  },
  BETTER_AUTH_URL: {
    class: "plain",
    schema: z.url().optional(),
    description:
      "The console's public origin, when it differs from the hostname ocel serves it on.",
  },
  githubAuth: group(
    {
      GITHUB_CLIENT_ID: { class: "plain" },
      GITHUB_CLIENT_SECRET: { class: "secret" },
    },
    { optional: true, description: "Enables sign-in with GitHub." },
  ),
  CONSOLE_EMAIL_AUTH: {
    class: "plain",
    schema: z.stringbool().default(false),
    description: "Enables sign-in with email and password.",
  },
  CONSOLE_SIGNUP: {
    class: "plain",
    schema: z.enum(["open", "invite"]).default("invite"),
    description:
      "open lets anyone sign up; invite lets only the first user and invited emails sign up.",
  },
  encryption: group(
    { CONSOLE_ENCRYPTION_KEY: { class: "secret" } },
    {
      optional: true,
      description:
        "Seals git apps' secrets at rest: 32 random bytes, base64. Git integrations need it.",
    },
  ),
  githubApp: group(
    {
      GITHUB_APP_ID: { class: "plain" },
      GITHUB_APP_SLUG: { class: "plain" },
      GITHUB_APP_PRIVATE_KEY: { class: "secret" },
      GITHUB_APP_WEBHOOK_SECRET: { class: "secret" },
      GITHUB_APP_CLIENT_ID: { class: "plain" },
      GITHUB_APP_CLIENT_SECRET: { class: "secret" },
    },
    {
      optional: true,
      description:
        "A GitHub App every organization can install. The console stores it as the system git app at start.",
    },
  ),
  CONSOLE_ISSUER_KMS_KEY_ID: {
    class: "plain",
    schema: z.string().min(1).optional(),
    description:
      "An AWS KMS ECC_NIST_P256 key (id, alias or ARN) the issuer signs with, over CONSOLE_ISSUER_KEY.",
  },
  CONSOLE_ISSUER_PREVIOUS_KMS_KEY_ID: {
    class: "plain",
    schema: z.string().min(1).optional(),
    description: "A retired KMS key whose public half the issuer still publishes.",
  },
  issuerKey: group(
    { CONSOLE_ISSUER_KEY: { class: "secret" } },
    {
      optional: true,
      description: "A P-256 private key, PEM or JWK, the issuer signs with when no KMS key is set.",
    },
  ),
  issuerPreviousKey: group(
    { CONSOLE_ISSUER_PREVIOUS_KEY: { class: "secret" } },
    {
      optional: true,
      description: "A retired P-256 key, PEM or JWK, whose public half the issuer still publishes.",
    },
  ),
  CONSOLE_TRUSTED_PROXY_HOPS: {
    class: "plain",
    schema: z.coerce.number().int().min(1).default(1),
    description:
      "Proxies in front of the console that append to X-Forwarded-For; the client is that many entries from the right.",
  },
  CONSOLE_PRICING_ANON_BURST: {
    class: "plain",
    schema: z.coerce.number().int().min(1).default(30),
    description: "Price lookups an anonymous address may make at once.",
  },
  CONSOLE_PRICING_ANON_PER_HOUR: {
    class: "plain",
    schema: z.coerce.number().positive().default(60),
    description: "Price lookups an anonymous address regains each hour.",
  },
  CONSOLE_PRICING_ORG_BURST: {
    class: "plain",
    schema: z.coerce.number().int().min(1).default(300),
    description: "Price lookups a signed-in organization may make at once.",
  },
  CONSOLE_PRICING_ORG_PER_HOUR: {
    class: "plain",
    schema: z.coerce.number().positive().default(1200),
    description: "Price lookups a signed-in organization regains each hour.",
  },
  ocelCloud: group(
    {
      CONSOLE_CLOUD_URL: {
        class: "plain",
        schema: z.url(),
        description: "The Ocel Cloud API the CLI deploys to.",
      },
      CONSOLE_CLOUD_PROVIDER_URL: {
        class: "plain",
        schema: z.url().optional(),
        description: "The hosted provider the CLI reaches for day-2 commands.",
      },
      CONSOLE_CLOUD_AUDIENCE: {
        class: "plain",
        schema: z.string().min(1).optional(),
        description:
          "The aud of the tokens the console signs for Ocel Cloud; the origin of CONSOLE_CLOUD_URL when unset.",
      },
    },
    {
      optional: true,
      description: "Offers Ocel Cloud as the target of a project that names no provider.",
    },
  ),
  gcpBilling: group(
    { GCP_BILLING_API_KEY: { class: "secret" } },
    {
      optional: true,
      description:
        "A Cloud Billing API key GCP prices are ingested with; without it, Application Default Credentials.",
    },
  ),
  CONSOLE_PRICING_GCP_PROJECT: {
    class: "plain",
    schema: z.string().min(1).optional(),
    description:
      "The project GCP price ingest bills its API quota to; the credentials' default project when unset.",
  },
  CONSOLE_PRICING_AWS_SOURCE: {
    class: "plain",
    schema: z.enum(["auto", "api", "bulk"]).default("auto"),
    description:
      "auto reads AWS prices from the Price List API when it lets the console in, else the public files; api or bulk picks one.",
  },
  CONSOLE_PRICING_AWS_ROLE_ARN: {
    class: "plain",
    schema: z.string().startsWith("arn:").optional(),
    description:
      "A pricing-only IAM role, in any AWS account, the console assumes to call the Price List API.",
  },
  CONSOLE_PRICING_AWS_IDENTITY: {
    class: "plain",
    schema: z.enum(["auto", "google", "aws"]).default("auto"),
    description:
      "Who assumes the pricing role: google, the host's service account; aws, its AWS credentials; auto, google on Cloud Run.",
  },
  CONSOLE_PRICING_AWS_AUDIENCE: {
    class: "plain",
    schema: z.string().min(1).default("sts.amazonaws.com"),
    description: "The audience of the Google ID token the console trades for the pricing role.",
  },
  pricingAwsKey: group(
    {
      CONSOLE_PRICING_AWS_ACCESS_KEY_ID: { class: "plain" },
      CONSOLE_PRICING_AWS_SECRET_ACCESS_KEY: { class: "secret" },
    },
    {
      optional: true,
      description:
        "An IAM user's access key the console calls the Price List API, or assumes the pricing role, with.",
    },
  ),
});
