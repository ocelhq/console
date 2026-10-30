import { describe, expect, it } from "vitest";
import { analyticsOf, relayed } from "./analytics";

describe("analyticsOf", () => {
  it("is off without a token", () => {
    expect(analyticsOf(undefined)).toBeNull();
  });

  it("serves PostHog Cloud's static files from its assets host", () => {
    expect(
      analyticsOf({
        CONSOLE_POSTHOG_TOKEN: "phc_x",
        CONSOLE_POSTHOG_HOST: "https://eu.i.posthog.com",
      }),
    ).toEqual({
      token: "phc_x",
      host: "https://eu.i.posthog.com",
      assetsHost: "https://eu-assets.i.posthog.com",
      uiHost: "https://eu.posthog.com",
    });
  });

  it("serves a self-hosted PostHog's static files from the same host", () => {
    expect(
      analyticsOf({ CONSOLE_POSTHOG_TOKEN: "phc_x", CONSOLE_POSTHOG_HOST: "https://ph.acme.dev/" }),
    ).toEqual({
      token: "phc_x",
      host: "https://ph.acme.dev",
      assetsHost: "https://ph.acme.dev",
      uiHost: "https://ph.acme.dev",
    });
  });
});

describe("relayed", () => {
  const analytics = {
    token: "phc_x",
    host: "https://us.i.posthog.com",
    assetsHost: "https://us-assets.i.posthog.com",
    uiHost: "https://us.posthog.com",
  };

  it("forwards an event to the ingestion host without the console's cookies", async () => {
    const request = new Request("https://console.acme.dev/relay/e/?ip=1&ver=1.443.0", {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=secret",
        "content-type": "text/plain",
        "x-forwarded-for": "203.0.113.7",
      },
      body: "payload",
    });

    const upstream = relayed(request, ["e", ""], analytics);

    expect(upstream.url).toBe("https://us.i.posthog.com/e/?ip=1&ver=1.443.0");
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(upstream.headers.get("content-type")).toBe("text/plain");
    expect(upstream.headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(await upstream.text()).toBe("payload");
  });

  it("fetches the recorder and other static files from the assets host", () => {
    const request = new Request("https://console.acme.dev/relay/static/recorder.js?v=1");

    expect(relayed(request, ["static", "recorder.js"], analytics).url).toBe(
      "https://us-assets.i.posthog.com/static/recorder.js?v=1",
    );
  });

  it("fetches the project's remote config from the assets host", () => {
    const request = new Request("https://console.acme.dev/relay/array/phc_x/config.js");

    expect(relayed(request, ["array", "phc_x", "config.js"], analytics).url).toBe(
      "https://us-assets.i.posthog.com/array/phc_x/config.js",
    );
  });
});
