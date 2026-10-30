import { env } from "@console/infra/env";

export interface Analytics {
  token: string;
  host: string;
  assetsHost: string;
  uiHost: string;
}

const posthogCloud = /^(us|eu)\.i\.posthog\.com$/;

export function analyticsOf(
  settings: { CONSOLE_POSTHOG_TOKEN: string; CONSOLE_POSTHOG_HOST: string } | undefined,
): Analytics | null {
  if (!settings) {
    return null;
  }
  const host = new URL(settings.CONSOLE_POSTHOG_HOST);
  const origin = host.origin;
  const region = posthogCloud.exec(host.hostname)?.[1];
  return {
    token: settings.CONSOLE_POSTHOG_TOKEN,
    host: origin,
    assetsHost: region ? `https://${region}-assets.i.posthog.com` : origin,
    uiHost: region ? `https://${region}.posthog.com` : origin,
  };
}

export function readAnalytics(): Analytics | null {
  return analyticsOf(env.posthog);
}

const assetPaths = new Set(["static", "array"]);

const forwarded = [
  "accept",
  "accept-language",
  "content-encoding",
  "content-type",
  "user-agent",
  "x-forwarded-for",
];

export function relayed(request: Request, path: string[], analytics: Analytics): Request {
  const base = assetPaths.has(path[0] ?? "") ? analytics.assetsHost : analytics.host;
  const url = new URL(`${base}/${path.join("/")}`);
  url.search = new URL(request.url).search;

  const headers = new Headers();
  for (const name of forwarded) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(url, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}
