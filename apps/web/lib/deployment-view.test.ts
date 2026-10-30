import { describe, expect, it } from "vitest";
import {
  atOf,
  deploymentStatus,
  duration,
  NO_REPORT_AFTER_MS,
  triggerLabel,
  UNREPORTED_SUCCESS,
  unreportedNote,
  viaOf,
} from "./deployment-view";

describe("deploymentStatus", () => {
  it("names a deployment that has not ended by where its run is", () => {
    const pending = { kind: "deploy" as const, outcome: null };
    expect(deploymentStatus(pending).word).toBe("Queued");
    expect(deploymentStatus({ ...pending, startedAt: new Date() }).word).toBe("Running");
    expect(deploymentStatus(pending, "running").word).toBe("Running");
    expect(deploymentStatus(pending, "input-required").word).toBe("Needs input");
  });

  it("names an ended deployment by its outcome", () => {
    expect(deploymentStatus({ kind: "deploy", outcome: "succeeded" })).toEqual({
      word: "Deployed",
      tone: "go",
    });
    expect(deploymentStatus({ kind: "deploy", outcome: "failed" }).tone).toBe("destructive");
    expect(deploymentStatus({ kind: "preview-up", outcome: "canceled" }).word).toBe("Canceled");
  });
});

describe("a deployment whose run ended without a report", () => {
  const pending = { kind: "deploy" as const, outcome: null };

  it("is named by how its job ended, never as still queued", () => {
    expect(deploymentStatus(pending, "canceled").word).toBe("Canceled");
    expect(deploymentStatus(pending, "failed").tone).toBe("destructive");
    expect(deploymentStatus(pending, "done").word).toBe("No report");
  });

  it("says no report came once a run with no job is far past any deploy's length", () => {
    const startedAt = new Date("2026-10-20T10:00:00.000Z");
    const later = new Date(startedAt.getTime() + NO_REPORT_AFTER_MS + 1000);
    expect(deploymentStatus({ ...pending, startedAt, jobId: null }, null, later).word).toBe(
      "No report",
    );
    expect(deploymentStatus({ ...pending, startedAt, jobId: "j" }, "running", later).word).toBe(
      "Running",
    );
    expect(deploymentStatus({ ...pending, startedAt, jobId: null }, null, startedAt).word).toBe(
      "Running",
    );
  });
});

describe("a deployment still running", () => {
  const createdAt = new Date("2026-10-20T10:00:00.000Z");
  const startedAt = new Date("2026-10-20T10:00:05.000Z");

  it("has no duration yet", () => {
    expect(duration({ startedAt, deployedAt: null })).toBeNull();
  });

  it("is stamped with when it started, or was queued", () => {
    expect(atOf({ deployedAt: null, startedAt, createdAt })).toBe(startedAt);
    expect(atOf({ deployedAt: null, startedAt: null, createdAt })).toBe(createdAt);
  });
});

describe("triggerLabel", () => {
  it("names a console rollback as coming from the console, and who ran it", () => {
    expect(triggerLabel({ kind: "console", actor: "Ada" }, "ocel rollback prm1234")).toBe(
      "from the console, by Ada",
    );
    expect(triggerLabel({ kind: "console" }, "ocel rollback prm1234")).toBe("from the console");
  });

  it("names any other trigger by the command it ran", () => {
    expect(triggerLabel({ kind: "cli" }, "ocel deploy")).toBe("ocel deploy");
  });
});

describe("a remote run's trigger", () => {
  it("says the deploy ran remotely, by whom, and on which runner", () => {
    expect(
      triggerLabel({ kind: "cli", actor: "Ada", remote: { runner: "box" } }, "ocel deploy"),
    ).toBe("ocel deploy --remote by Ada, on runner box");
    expect(triggerLabel({ kind: "cli", remote: { runner: "ocel-cloud" } }, "ocel deploy")).toBe(
      "ocel deploy --remote, on Ocel Cloud's runner",
    );
  });

  it("names a run reported from inside a runner as via a runner", () => {
    expect(viaOf({ kind: "ci", ci: { provider: "ocel-runner" } })).toBe("via a runner");
    expect(viaOf({ kind: "ci", ci: { provider: "github-actions" } })).toBe("via github-actions");
    expect(viaOf({ kind: "cli" })).toBeNull();
  });
});

describe("unreportedNote", () => {
  it("notes a job's success the console recorded because ocel never reported it", () => {
    expect(unreportedNote({ outcome: "succeeded", outcomeBy: "console", jobId: "j" })).toBe(
      UNREPORTED_SUCCESS,
    );
  });

  it("says nothing for ocel's own report, a console rollback, or a failure", () => {
    expect(unreportedNote({ outcome: "succeeded", outcomeBy: "ocel", jobId: "j" })).toBeNull();
    expect(unreportedNote({ outcome: "succeeded", outcomeBy: "console", jobId: null })).toBeNull();
    expect(unreportedNote({ outcome: "failed", outcomeBy: "console", jobId: "j" })).toBeNull();
  });
});
