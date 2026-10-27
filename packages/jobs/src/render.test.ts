import type { Job } from "@console/db/schema";
import { describe, expect, it } from "vitest";
import { PREVIEW_MARKER, renderPreviewComment } from "./render";

const sha = "abcdef1".padEnd(40, "0");
const RUN_URL = "https://github.com/acme/web/actions/runs/9/attempts/1";

function job(over: Partial<Job> = {}): Job {
  return {
    id: "j",
    projectId: "p",
    kind: "preview-up",
    status: "done",
    pr: 7,
    sha,
    branch: "feat/x",
    labels: [],
    dedupeKey: "d",
    eventAt: new Date(),
    runnerId: null,
    leaseUntil: null,
    cancelRequested: false,
    claims: 0,
    deploymentId: "dep-1",
    error: null,
    runUrl: null,
    createdAt: new Date(),
    claimedAt: new Date(),
    startedAt: new Date(),
    finishedAt: new Date(),
    revision: 1,
    syncedRevision: 0,
    changedAt: new Date(),
    ...over,
  };
}

const deployed = {
  provider: "aws",
  finishedAt: new Date("2026-10-27T10:03:00.000Z"),
  apps: [
    { name: "web", url: "https://pr-7.example.com" },
    { name: "worker", url: undefined },
  ],
};

describe("the preview comment", () => {
  it("shows a ready preview's provider, commit, apps and run log", () => {
    const body = renderPreviewComment("acme/web", [
      { project: "Web", job: job({ runUrl: RUN_URL }), deployment: deployed },
    ]);

    expect(body.startsWith(PREVIEW_MARKER)).toBe(true);
    expect(body).toContain("#### Web");
    expect(body).toContain(
      'providers/aws.svg" alt="AWS" height="14"> Deployed [`abcdef1`](https://github.com/acme/web/commit/' +
        sha +
        ") to your AWS account · Oct 27, 2026, 10:03 UTC",
    );
    expect(body).toContain("| web | [Visit preview ↗](https://pr-7.example.com) | ✅ Ready |");
    expect(body).toContain("| worker | no url | ❌ No URL |");
    expect(body).toContain(`[Run log](${RUN_URL})`);
  });

  it("names a provider it has no mark for", () => {
    const body = renderPreviewComment("acme/web", [
      { project: "Web", job: job(), deployment: { ...deployed, provider: "gcp" } },
    ]);

    expect(body).toContain("Deployed [`abcdef1`]");
    expect(body).toContain("to gcp ·");
    expect(body).not.toContain("<img");
  });

  it("shows why a preview failed", () => {
    const body = renderPreviewComment("acme/web", [
      { project: "Web", job: job({ status: "failed", error: "build broke\nat step 2" }) },
    ]);

    expect(body).toContain("❌ Preview failed for [`abcdef1`]");
    expect(body).toContain("on `feat/x`");
    expect(body).toContain("```\nbuild broke\nat step 2\n```");
  });

  it("says a preview is waiting, deploying or removed", () => {
    const body = renderPreviewComment("acme/web", [
      { project: "A", job: job({ status: "queued" }) },
      { project: "B", job: job({ status: "running" }) },
      { project: "C", job: job({ kind: "preview-rm", sha: null, status: "done" }) },
    ]);

    expect(body).toContain("Waiting for a runner");
    expect(body).toContain("🔄 Deploying [`abcdef1`]");
    expect(body).toContain("💤 Removed");
  });
});
