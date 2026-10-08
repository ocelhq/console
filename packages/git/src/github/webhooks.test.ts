import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MalformedWebhook } from "../provider";
import { githubProvider } from "./provider";
import { delivery, testApp, WEBHOOK_SECRET } from "./test-support";

const provider = githubProvider(testApp());

const repository = { id: 1234, full_name: "acme/web" };
const installation = { id: 99 };

function pullRequest(action: string, extra: Record<string, unknown> = {}) {
  return delivery("pull_request", {
    action,
    number: 7,
    installation,
    repository,
    pull_request: {
      head: { sha: "a".repeat(40), ref: "feature/x", repo: { id: 1234 } },
      merged: false,
      draft: false,
      ...extra,
    },
  });
}

describe("verifyWebhook", () => {
  it("accepts a delivery signed with the app's webhook secret", async () => {
    expect(await provider.verifyWebhook(pullRequest("opened"))).toBe(true);
  });

  it("refuses a delivery signed with another secret", async () => {
    expect(await provider.verifyWebhook(delivery("push", {}, "someone-else"))).toBe(false);
  });

  it("refuses a delivery with no signature", async () => {
    const request = delivery("push", {});
    request.headers.delete("x-hub-signature-256");
    expect(await provider.verifyWebhook(request)).toBe(false);
  });

  it("refuses a body changed after signing", async () => {
    const request = delivery("push", { ref: "refs/heads/main" });
    expect(await provider.verifyWebhook({ ...request, body: `${request.body} ` })).toBe(false);
  });

  it("refuses a malformed signature rather than throwing", async () => {
    const request = delivery("push", {});
    request.headers.set("x-hub-signature-256", "sha256=zz");
    expect(await provider.verifyWebhook(request)).toBe(false);
  });

  it("verifies an empty body rather than throwing", async () => {
    const signed = signedBody("");
    expect(await provider.verifyWebhook(signed)).toBe(true);
  });

  it("opens only the webhook secret to verify", async () => {
    const app = testApp();
    await githubProvider(app).verifyWebhook(delivery("push", {}));
    expect(app.opened).toEqual(["webhookSecret"]);
  });
});

function signedBody(body: string, contentType?: string) {
  const headers = new Headers({
    "x-github-event": "push",
    "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
  });
  if (contentType) headers.set("content-type", contentType);
  return { headers, body };
}

describe("deliveryId", () => {
  it("reads GitHub's delivery id", () => {
    const request = delivery("push", {});
    expect(provider.deliveryId(request)).toBe(request.headers.get("x-github-delivery"));
  });
});

describe("parseEvent", () => {
  it("reads a push to a branch", () => {
    const event = provider.parseEvent(
      delivery("push", {
        ref: "refs/heads/main",
        after: "b".repeat(40),
        deleted: false,
        installation,
        repository,
      }),
    );
    expect(event).toEqual({
      type: "push",
      installation: "99",
      repo: { id: "1234", fullName: "acme/web" },
      branch: "main",
      sha: "b".repeat(40),
      deleted: false,
    });
  });

  it("ignores a push to a tag", () => {
    expect(
      provider.parseEvent(
        delivery("push", { ref: "refs/tags/v1", after: "b".repeat(40), installation, repository }),
      ),
    ).toBeUndefined();
  });

  it.each([
    ["opened", "pr_opened"],
    ["reopened", "pr_opened"],
    ["ready_for_review", "pr_opened"],
    ["synchronize", "pr_sync"],
  ])("reads a pull request %s as %s", (action, type) => {
    expect(provider.parseEvent(pullRequest(action))).toEqual({
      type,
      installation: "99",
      repo: { id: "1234", fullName: "acme/web" },
      pr: 7,
      sha: "a".repeat(40),
      branch: "feature/x",
      draft: false,
      fork: false,
    });
  });

  it("says when a pull request is a draft", () => {
    expect(provider.parseEvent(pullRequest("opened", { draft: true }))).toMatchObject({
      draft: true,
    });
  });

  it("says when a pull request comes from a fork", () => {
    const fromFork = pullRequest("opened", {
      head: { sha: "a".repeat(40), ref: "feature/x", repo: { id: 999 } },
    });
    expect(provider.parseEvent(fromFork)).toMatchObject({ fork: true });
  });

  it("takes a pull request whose head repository is gone for a fork", () => {
    const deleted = pullRequest("synchronize", {
      head: { sha: "a".repeat(40), ref: "feature/x", repo: null },
    });
    expect(provider.parseEvent(deleted)).toMatchObject({ type: "pr_sync", fork: true });
  });

  it("reads a merged pull request as closed and merged", () => {
    expect(provider.parseEvent(pullRequest("closed", { merged: true }))).toEqual({
      type: "pr_closed",
      installation: "99",
      repo: { id: "1234", fullName: "acme/web" },
      pr: 7,
      merged: true,
    });
  });

  it("ignores pull request actions it has no use for", () => {
    expect(provider.parseEvent(pullRequest("labeled"))).toBeUndefined();
  });

  it("reads an installation removed, and leaves binding a new one to the setup flow", () => {
    const payload = { installation: { id: 99, account: { login: "acme" } } };
    expect(
      provider.parseEvent(delivery("installation", { action: "created", ...payload })),
    ).toBeUndefined();
    expect(
      provider.parseEvent(delivery("installation", { action: "deleted", ...payload })),
    ).toEqual({
      type: "uninstalled",
      installation: "99",
    });
  });

  it("ignores events it does not know", () => {
    expect(provider.parseEvent(delivery("star", {}))).toBeUndefined();
  });

  it("reads a delivery GitHub sent form-encoded", () => {
    const payload = {
      ref: "refs/heads/main",
      after: "b".repeat(40),
      installation,
      repository,
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    expect(
      provider.parseEvent(signedBody(body, "application/x-www-form-urlencoded")),
    ).toMatchObject({ type: "push", branch: "main" });
  });

  it.each([
    ["an empty body", signedBody("")],
    ["a body that is not JSON", signedBody("not json")],
    ["a form with no payload", signedBody("a=b", "application/x-www-form-urlencoded")],
  ])("refuses %s as malformed", (_, request) => {
    expect(() => provider.parseEvent(request)).toThrow(MalformedWebhook);
  });
});
