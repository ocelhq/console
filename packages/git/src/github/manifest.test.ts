import { describe, expect, it } from "vitest";
import { appName, convertManifest, githubManifest, manifestStartUrl } from "./manifest";

describe("githubManifest", () => {
  const manifest = githubManifest({
    origin: "https://console.example.com",
    appRowId: "app_1",
    name: "Acme Ocel",
  });

  it("points GitHub's webhooks at the route that will hold the app's secret", () => {
    expect(manifest.hook_attributes).toEqual({
      url: "https://console.example.com/api/git/github/app_1/webhooks",
      active: true,
    });
  });

  it("sends the creator back to the callback", () => {
    expect(manifest.redirect_url).toBe(
      "https://console.example.com/api/git/github/manifest/callback",
    );
  });

  it("sends whoever installs the app through the setup that binds it to an organization", () => {
    expect(manifest.setup_url).toBe("https://console.example.com/api/git/github/app_1/setup");
    expect(manifest.setup_on_update).toBe(true);
    expect(manifest.callback_urls).toEqual([
      "https://console.example.com/api/git/github/app_1/authorized",
    ]);
    expect(manifest.request_oauth_on_install).toBe(false);
  });

  it("asks for what the provider port does, and no more", () => {
    expect(manifest.default_permissions).toEqual({
      metadata: "read",
      contents: "read",
      pull_requests: "write",
      issues: "write",
      statuses: "write",
      deployments: "write",
    });
    expect(manifest.default_events).toEqual(["push", "pull_request"]);
    expect(manifest.public).toBe(false);
  });
});

describe("appName", () => {
  it("is different each time, so registering again never collides on GitHub", () => {
    const names = new Set(Array.from({ length: 20 }, () => appName("org_123456789")));
    expect(names.size).toBe(20);
  });

  it("fits GitHub's 34 character limit", () => {
    expect(appName("o".repeat(64)).length).toBeLessThanOrEqual(34);
  });
});

describe("manifestStartUrl", () => {
  it("registers the app on the person's account by default", () => {
    expect(manifestStartUrl(undefined, "s")).toBe("https://github.com/settings/apps/new?state=s");
  });

  it("registers it on an organization when one is named", () => {
    expect(manifestStartUrl("acme-inc", "s")).toBe(
      "https://github.com/organizations/acme-inc/settings/apps/new?state=s",
    );
  });
});

describe("convertManifest", () => {
  const conversion = {
    id: 4242,
    slug: "acme-ocel",
    client_id: "Iv1.abc",
    client_secret: "client-secret",
    webhook_secret: "whsec",
    pem: "-----BEGIN RSA PRIVATE KEY-----",
    html_url: "https://github.com/apps/acme-ocel",
  };

  it("trades the code for the app's credentials", async () => {
    const calls: { url: string; method?: string }[] = [];
    const fetchFake: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return Response.json(conversion, { status: 201 });
    };

    expect(await convertManifest("the-code", fetchFake)).toEqual({
      appId: "4242",
      slug: "acme-ocel",
      clientId: "Iv1.abc",
      clientSecret: "client-secret",
      webhookSecret: "whsec",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----",
    });
    expect(calls).toEqual([
      { url: "https://api.github.com/app-manifests/the-code/conversions", method: "POST" },
    ]);
  });

  it("fails when GitHub refuses the code", async () => {
    const refused: typeof fetch = async () =>
      Response.json({ message: "Not Found" }, { status: 404 });
    await expect(convertManifest("stale", refused)).rejects.toThrow(/Not Found/);
  });
});
