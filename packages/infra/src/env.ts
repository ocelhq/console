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
  posthog: group(
    {
      CONSOLE_POSTHOG_TOKEN: {
        class: "plain",
        description: "The PostHog project token (phc_…). It is public: browsers send it.",
      },
      CONSOLE_POSTHOG_HOST: {
        class: "plain",
        schema: z.url(),
        description:
          "Where browsers send events: https://us.i.posthog.com, https://eu.i.posthog.com, a managed proxy, or your own PostHog.",
      },
      CONSOLE_POSTHOG_UI_HOST: {
        class: "plain",
        schema: z.url().optional(),
        description:
          "Where links into PostHog open, when CONSOLE_POSTHOG_HOST is a proxy: https://us.posthog.com or https://eu.posthog.com.",
      },
    },
    {
      optional: true,
      description:
        "Sends product analytics, session replays and errors to PostHog. Off unless set.",
    },
  ),
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
});
