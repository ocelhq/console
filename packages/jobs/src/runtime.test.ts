import type { Job } from "@console/db/schema";
import type { GitEvent } from "@console/git";
import { describe, expect, it } from "vitest";
import { notifyJobChanged, queueGitEvent, syncFailure, type Triggers } from "./runtime";

const repo = { id: "1", fullName: "acme/web" };
const at = new Date("2026-10-08T10:00:00Z");
const opened: GitEvent = {
  type: "pr_opened",
  reopened: false,
  installation: "556",
  repo,
  pr: 7,
  sha: "a".repeat(40),
  branch: "x",
  draft: false,
  fork: false,
  at,
};

function recording() {
  const triggered: { task: string; payload: unknown; options: unknown }[] = [];
  const triggers: Triggers = {
    gitEvent: async (payload, options) => {
      triggered.push({ task: "git-event", payload, options });
    },
    gitSync: async (payload, options) => {
      triggered.push({ task: "git-sync", payload, options });
    },
  };
  return { triggered, triggers };
}

describe("queueGitEvent", () => {
  const context = { deliveryId: "d-1", app: { id: "app-1" } } as never;

  it("triggers git-event with the delivery, in order with the pull request's other events", async () => {
    const { triggered, triggers } = recording();

    await queueGitEvent(triggers)(opened, context);

    expect(triggered).toEqual([
      {
        task: "git-event",
        payload: {
          deliveryId: "d-1",
          appId: "app-1",
          event: { ...opened, at: "2026-10-08T10:00:00.000Z" },
        },
        options: { key: "app-1:1#pr-7" },
      },
    ]);
  });

  it("orders a push with the other pushes to its branch", async () => {
    const { triggered, triggers } = recording();
    const push: GitEvent = {
      type: "push",
      installation: "556",
      repo,
      branch: "main",
      sha: "b".repeat(40),
      deleted: false,
      at,
    };

    await queueGitEvent(triggers)(push, context);

    expect(triggered[0]?.options).toEqual({ key: "app-1:1#main" });
  });

  it("sets no idempotency key, so GitHub's Redeliver of a failed event runs it again", async () => {
    const { triggered, triggers } = recording();

    await queueGitEvent(triggers)(opened, context);

    expect(triggered[0]?.options).not.toHaveProperty("idempotencyKey");
  });
});

describe("syncFailure", () => {
  it.each([
    [{ status: 404 }, true],
    [{ status: 403 }, true],
    [{ status: 422 }, true],
    [{ status: 429 }, false],
    [{ status: 408 }, false],
    [{ status: 502 }, false],
    [new Error("socket hang up"), false],
  ])("%j gives up: %s", (error, permanent) => {
    expect(syncFailure(error)).toEqual(permanent ? { skipRetrying: true } : undefined);
  });
});

describe("notifyJobChanged", () => {
  const linked = async () => ({ installationId: "inst-1", repoId: "1" });

  it("orders a preview's syncs by its repo and pull request, which every linked project shares", async () => {
    const { triggered, triggers } = recording();

    await notifyJobChanged(
      triggers,
      linked,
    )({
      id: "j",
      projectId: "p",
      kind: "preview-up",
      pr: 7,
      sha: "x",
      revision: 3,
    } as Job);

    expect(triggered).toEqual([
      {
        task: "git-sync",
        payload: { jobId: "j" },
        options: { key: "inst-1:1#pr-7", idempotencyKey: "j@3", idempotencyKeyTTL: "1h" },
      },
    ]);
  });

  it("orders a deploy's syncs by its project and commit", async () => {
    const { triggered, triggers } = recording();

    await notifyJobChanged(
      triggers,
      linked,
    )({
      id: "j",
      projectId: "p",
      kind: "deploy",
      pr: 0,
      sha: "x",
      revision: 1,
    } as Job);

    expect(triggered[0]?.options).toMatchObject({ key: "p#x" });
  });

  it("falls back to the project for a preview whose project left the repo", async () => {
    const { triggered, triggers } = recording();

    await notifyJobChanged(
      triggers,
      async () => undefined,
    )({ id: "j", projectId: "p", kind: "preview-rm", pr: 7, sha: null, revision: 1 } as Job);

    expect(triggered[0]?.options).toMatchObject({ key: "p#pr-7" });
  });
});
