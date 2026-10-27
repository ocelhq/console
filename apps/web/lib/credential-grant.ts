import type { CredentialGrant } from "@console/db/schema";
import { parsePatterns } from "@console/git";

export interface GrantInput {
  production: { enabled: boolean; branches: string; environment: string };
  preview: { enabled: boolean; branches: string };
}

export type GrantAnswer = { ok: true; grant: CredentialGrant } | { ok: false; message: string };

export function credentialGrantOf(input: GrantInput): GrantAnswer {
  const grant: CredentialGrant = {};
  if (input.production.enabled) {
    const branches = parsePatterns(input.production.branches);
    if (branches.length === 0) {
      return {
        ok: false,
        message:
          "Name the branches whose runs get production credentials, such as main. * names every branch.",
      };
    }
    const environment = input.production.environment.trim();
    grant.production = { branches, ...(environment ? { environment } : {}) };
  }
  if (input.preview.enabled) {
    const branches = parsePatterns(input.preview.branches);
    if (branches.length === 0) {
      return {
        ok: false,
        message: "Name the branches whose runs get preview credentials. * names every branch.",
      };
    }
    grant.preview = { branches };
  }
  return { ok: true, grant };
}
