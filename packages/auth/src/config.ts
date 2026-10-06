import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { db } from "@console/db";
import * as schema from "@console/db/schema";
import { env } from "@console/infra/env";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, deviceAuthorization, jwt, organization } from "better-auth/plugins";
import { asc, eq } from "drizzle-orm";
import { OCEL_CLI_CLIENT_ID } from "./constants";
import { consoleOrigin } from "./origin";
import { readAuthSettings } from "./settings";
import { maySignUp } from "./signup";
import { databaseSignupStore } from "./signup-store";

const building = process.env.NEXT_PHASE === "phase-production-build";
const settings = readAuthSettings();

export const authConfig = {
  secret: building ? undefined : env.BETTER_AUTH_SECRET,
  baseURL: building ? undefined : consoleOrigin(),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: settings.email,
  },
  socialProviders: settings.github ? { github: settings.github } : {},
  session: {
    expiresIn: 60 * 60 * 24 * 30,
  },
  databaseHooks: {
    user: {
      create: {
        before: async (created) => {
          if (!(await maySignUp(created.email, settings.signup, databaseSignupStore))) {
            throw new APIError("FORBIDDEN", {
              message: "This console is invite-only. Ask an admin to invite your email address.",
            });
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const [membership] = await db
            .select({ organizationId: schema.member.organizationId })
            .from(schema.member)
            .where(eq(schema.member.userId, session.userId))
            .orderBy(asc(schema.member.createdAt))
            .limit(1);

          return {
            data: { ...session, activeOrganizationId: membership?.organizationId ?? null },
          };
        },
      },
    },
  },
  plugins: [
    organization(),
    bearer(),
    jwt({
      jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } },
      disableSettingJwtHeader: true,
    }),
    deviceAuthorization({
      verificationUri: "/device",
      validateClient: async (clientId) => clientId === OCEL_CLI_CLIENT_ID,
    }),
  ],
} satisfies BetterAuthOptions;
