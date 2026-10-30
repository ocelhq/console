import { env } from "@console/infra/env";

export interface Analytics {
  token: string;
  host: string;
  uiHost: string;
}

const posthogCloud = /^(us|eu)\.i\.posthog\.com$/;

export function analyticsOf(
  settings:
    | {
        CONSOLE_POSTHOG_TOKEN: string;
        CONSOLE_POSTHOG_HOST: string;
        CONSOLE_POSTHOG_UI_HOST?: string;
      }
    | undefined,
): Analytics | null {
  if (!settings) {
    return null;
  }
  const host = new URL(settings.CONSOLE_POSTHOG_HOST);
  const region = posthogCloud.exec(host.hostname)?.[1];
  const uiHost = settings.CONSOLE_POSTHOG_UI_HOST
    ? new URL(settings.CONSOLE_POSTHOG_UI_HOST).origin
    : region
      ? `https://${region}.posthog.com`
      : host.origin;
  return { token: settings.CONSOLE_POSTHOG_TOKEN, host: host.origin, uiHost };
}

export function readAnalytics(): Analytics | null {
  return analyticsOf(env.posthog);
}
