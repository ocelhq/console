import { randomBytes } from "node:crypto";
import type { AppCredentials } from "../store";

export function appName(organizationId: string): string {
  return `Ocel ${organizationId.slice(0, 8)} ${randomBytes(4).toString("hex")}`;
}

export function githubManifest(input: { origin: string; appRowId: string; name: string }) {
  const app = `${input.origin}/api/git/github/${input.appRowId}`;
  return {
    name: input.name,
    url: input.origin,
    hook_attributes: {
      url: `${app}/webhooks`,
      active: true,
    },
    redirect_url: `${input.origin}/api/git/github/manifest/callback`,
    setup_url: `${app}/setup`,
    setup_on_update: true,
    callback_urls: [`${app}/authorized`],
    request_oauth_on_install: false,
    public: false,
    default_permissions: {
      metadata: "read",
      members: "read",
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
