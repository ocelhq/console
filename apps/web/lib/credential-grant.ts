import type { CredentialGrant } from "@console/db/schema";
import { parseBranches } from "@console/git";

export interface GrantInput {
  production: { enabled: boolean; branches: string; environment: string };
  preview: { enabled: boolean; branches: string };
}

export type GrantAnswer = { ok: true; grant: CredentialGrant } | { ok: false; message: string };

export function credentialGrantOf(input: GrantInput, productionBranch?: string): GrantAnswer {
  const grant: CredentialGrant = {};
  if (input.production.enabled) {
    if (productionBranch === undefined && input.production.branches.trim() === "") {
      return {
        ok: false,
        message: "Name the branches whose runs get production credentials, such as main.",
      };
    }
    const environment = input.production.environment.trim();
    grant.production = {
      branches:
        productionBranch === undefined
          ? parseBranches(input.production.branches)
          : [productionBranch],
      ...(environment ? { environment } : {}),
    };
  }
  if (input.preview.enabled) {
    grant.preview = { branches: parseBranches(input.preview.branches) };
  }
  return { ok: true, grant };
}
