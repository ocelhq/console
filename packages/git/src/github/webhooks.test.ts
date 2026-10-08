import { describe, expect, it } from "vitest";
import { githubProvider } from "./provider";
import { delivery, PRIVATE_KEY, WEBHOOK_SECRET } from "./test-support";

const provider = githubProvider({
  appId: "7",
  privateKey: PRIVATE_KEY,
  webhookSecret: WEBHOOK_SECRET,
});

const repository = { id: 1234, full_name: "acme/web" };
const installation = { id: 99 };

function pullRequest(action: string, extra: Record<string, unknown> = {}) {
  return delivery("pull_request", {
    action,
    number: 7,
    installation,
    repository,
    pull_request: {
      head: { sha: "a".repeat(40), ref: "feature/x" },
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
    ["synchronize", "pr_sync"],
  ])("reads a pull request %s as %s", (action, type) => {
    expect(provider.parseEvent(pullRequest(action))).toEqual({
      type,
      installation: "99",
      repo: { id: "1234", fullName: "acme/web" },
      pr: 7,
      sha: "a".repeat(40),
      branch: "feature/x",
    });
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

  it("reads an installation made and removed", () => {
    const payload = { installation: { id: 99, account: { login: "acme" } } };
    expect(
      provider.parseEvent(delivery("installation", { action: "created", ...payload })),
    ).toEqual({
      type: "installed",
      installation: "99",
      account: "acme",
    });
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
});
