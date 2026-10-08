import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppCredentials } from "../store";

const STATE_LIFETIME_MS = 60 * 60 * 1000;

export interface StateClaims {
  organizationId: string;
  userId: string;
  appRowId: string;
}

export function githubManifest(input: { origin: string; appRowId: string; name: string }) {
  return {
    name: input.name,
    url: input.origin,
    hook_attributes: {
      url: `${input.origin}/api/git/github/${input.appRowId}/webhooks`,
      active: true,
    },
    redirect_url: `${input.origin}/api/git/github/manifest/callback`,
    public: false,
    default_permissions: {
      metadata: "read",
      contents: "read",
      pull_requests: "write",
      issues: "write",
      statuses: "write",
      deployments: "write",
    },
    default_events: ["push", "pull_request"],
  };
}

export function manifestStartUrl(owner: string | undefined, state: string): string {
  const base = owner
    ? `https://github.com/organizations/${owner}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  return `${base}?state=${state}`;
}

function mac(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signState(claims: StateClaims, secret: string, now = new Date()): string {
  const payload = Buffer.from(
    JSON.stringify({ ...claims, exp: now.getTime() + STATE_LIFETIME_MS }),
  ).toString("base64url");
  return `${payload}.${mac(payload, secret).toString("base64url")}`;
}

export function verifyState(
  state: string,
  secret: string,
  now = new Date(),
): StateClaims | undefined {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return undefined;

  const expected = mac(payload, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;

  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as StateClaims & {
    exp: number;
  };
  if (!(claims.exp > now.getTime())) return undefined;
  return {
    organizationId: claims.organizationId,
    userId: claims.userId,
    appRowId: claims.appRowId,
  };
}

interface Conversion {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
  message?: string;
}

export async function convertManifest(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AppCredentials> {
  const response = await fetchImpl(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    { method: "POST", headers: { accept: "application/vnd.github+json" } },
  );
  const body = (await response.json()) as Conversion;
  if (!response.ok) {
    throw new Error(`github refused the manifest code: ${body.message ?? response.status}`);
  }
  return {
    appId: String(body.id),
    slug: body.slug,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    webhookSecret: body.webhook_secret,
    privateKey: body.pem,
  };
}
