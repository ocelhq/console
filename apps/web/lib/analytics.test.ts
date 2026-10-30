import { describe, expect, it } from "vitest";
import { analyticsOf } from "./analytics";

describe("analyticsOf", () => {
  it("is off without a token", () => {
    expect(analyticsOf(undefined)).toBeNull();
  });

  it("opens PostHog Cloud's app for its region's ingestion host", () => {
    expect(
      analyticsOf({
        CONSOLE_POSTHOG_TOKEN: "phc_x",
        CONSOLE_POSTHOG_HOST: "https://eu.i.posthog.com",
      }),
    ).toEqual({
      token: "phc_x",
      host: "https://eu.i.posthog.com",
      uiHost: "https://eu.posthog.com",
    });
  });

  it("opens the app it is told to behind a managed proxy", () => {
    expect(
      analyticsOf({
        CONSOLE_POSTHOG_TOKEN: "phc_x",
        CONSOLE_POSTHOG_HOST: "https://e.ocelhq.com/",
        CONSOLE_POSTHOG_UI_HOST: "https://us.posthog.com",
      }),
    ).toEqual({ token: "phc_x", host: "https://e.ocelhq.com", uiHost: "https://us.posthog.com" });
  });

  it("opens a self-hosted PostHog at its own host", () => {
    expect(
      analyticsOf({ CONSOLE_POSTHOG_TOKEN: "phc_x", CONSOLE_POSTHOG_HOST: "https://ph.acme.dev" }),
    ).toEqual({ token: "phc_x", host: "https://ph.acme.dev", uiHost: "https://ph.acme.dev" });
  });
});
