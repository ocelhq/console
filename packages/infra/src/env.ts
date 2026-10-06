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
});
