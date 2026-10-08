import { createHmac, timingSafeEqual } from "node:crypto";

const LIFETIME_MS = 60 * 60 * 1000;

export interface StateClaims {
  manifest: { organizationId: string; userId: string; appRowId: string };
  authorize: { organizationId: string; userId: string; appRowId: string; installation: string };
}

export type StatePurpose = keyof StateClaims;

function keyFor(purpose: StatePurpose, secret: string): Buffer {
  return createHmac("sha256", secret).update(`ocel-console/git-state/${purpose}`).digest();
}

function mac(purpose: StatePurpose, payload: string, secret: string): Buffer {
  return createHmac("sha256", keyFor(purpose, secret)).update(payload).digest();
}

export function signState<P extends StatePurpose>(
  purpose: P,
  claims: StateClaims[P],
  secret: string,
  now = new Date(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ ...claims, exp: now.getTime() + LIFETIME_MS }),
  ).toString("base64url");
  return `${payload}.${mac(purpose, payload, secret).toString("base64url")}`;
}

export function verifyState<P extends StatePurpose>(
  purpose: P,
  state: string,
  secret: string,
  now = new Date(),
): StateClaims[P] | undefined {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;

  const expected = mac(purpose, payload, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;

  const { exp, ...claims } = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (!(typeof exp === "number" && exp > now.getTime())) return undefined;
  return claims;
}
