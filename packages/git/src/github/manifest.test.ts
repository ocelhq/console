import { describe, expect, it } from "vitest";
import {
  convertManifest,
  githubManifest,
  manifestStartUrl,
  signState,
  verifyState,
} from "./manifest";

const secret = "state-secret-at-least-32-characters";
const now = new Date("2026-10-08T12:00:00Z");
const claims = { organizationId: "org_1", userId: "user_1", appRowId: "app_1" };

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

describe("state", () => {
  it("round-trips its claims", () => {
    expect(verifyState(signState(claims, secret, now), secret, now)).toEqual(claims);
  });

  it("refuses a state signed under another secret", () => {
    expect(
      verifyState(signState(claims, "other-secret-other-secret-other-secret", now), secret, now),
    ).toBeUndefined();
  });

  it("refuses a state whose claims were changed", () => {
    const [payload, signature] = signState(claims, secret, now).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...claims, organizationId: "org_2", exp: Infinity }),
    ).toString("base64url");
    expect(payload).not.toBe(forged);
    expect(verifyState(`${forged}.${signature}`, secret, now)).toBeUndefined();
  });

  it("refuses a state older than an hour", () => {
    const later = new Date(now.getTime() + 61 * 60 * 1000);
    expect(verifyState(signState(claims, secret, now), secret, later)).toBeUndefined();
  });

  it("refuses what is not a state", () => {
    expect(verifyState("garbage", secret, now)).toBeUndefined();
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
