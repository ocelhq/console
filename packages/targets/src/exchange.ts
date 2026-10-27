import type { TierIdentity } from "./vendors";

export interface Exchange {
  vendor: string;
  identity: TierIdentity;
  token: string;
  sessionName: string;
}

export type ExchangeResult = { ok: true; detail: string } | { ok: false; error: string };

const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";

function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function aws(
  { identity, token, sessionName }: Exchange,
  fetch: typeof globalThis.fetch,
): Promise<ExchangeResult> {
  const response = await fetch("https://sts.amazonaws.com/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Action: "AssumeRoleWithWebIdentity",
      Version: "2011-06-15",
      RoleArn: identity.principal,
      RoleSessionName: sessionName,
      WebIdentityToken: token,
      DurationSeconds: "900",
    }).toString(),
  });
  const xml = await response.text();
  if (!response.ok) {
    const code = tag(xml, "Code") ?? `HTTP ${response.status}`;
    return {
      ok: false,
      error: `AWS STS refused the token: ${code}: ${tag(xml, "Message") ?? "no message"}`,
    };
  }
  return { ok: true, detail: `assumed ${tag(xml, "Arn") ?? identity.principal}` };
}

async function gcp(
  { identity, token }: Exchange,
  fetch: typeof globalThis.fetch,
): Promise<ExchangeResult> {
  const traded = await fetch("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      audience: identity.identityProvider,
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      scope: CLOUD_PLATFORM,
      subjectToken: token,
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    }),
  });
  const federated = await json(traded);
  if (!traded.ok || typeof federated.access_token !== "string") {
    return {
      ok: false,
      error: `Google STS refused the token: ${federated.error ?? `HTTP ${traded.status}`}: ${federated.error_description ?? "no description"}`,
    };
  }

  const impersonated = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(identity.principal)}:generateAccessToken`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${federated.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: [CLOUD_PLATFORM], lifetime: "300s" }),
    },
  );
  if (!impersonated.ok) {
    const { error } = (await json(impersonated)) as {
      error?: { status?: string; message?: string };
    };
    return {
      ok: false,
      error: `Google refused to impersonate ${identity.principal}: ${error?.status ?? `HTTP ${impersonated.status}`}: ${error?.message ?? "no message"}`,
    };
  }
  return { ok: true, detail: `impersonated ${identity.principal}` };
}

export async function exchangeToken(
  exchange: Exchange,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ExchangeResult> {
  try {
    switch (exchange.vendor) {
      case "aws":
        return await aws(exchange, fetch);
      case "gcp":
        return await gcp(exchange, fetch);
      default:
        return { ok: false, error: `The console cannot test a ${exchange.vendor} target` };
    }
  } catch (thrown) {
    return {
      ok: false,
      error: `The exchange failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    };
  }
}
