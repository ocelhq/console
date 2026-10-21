import type { CloudJob } from "@console/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelJob, jobHref, readEvents, refusalOf, respondToJob } from "./cloud-job-client";

const ref = { id: "job_1", organizationId: "org 1" };

const job = { id: "job_1", state: "canceled" } as CloudJob;

function answering(...responses: (Response | Error)[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetch.mockRejectedValueOnce(response);
    else fetch.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the job page's urls", () => {
  it("links the job page for the organization it belongs to", () => {
    expect(jobHref(ref)).toBe("/cloud/jobs/job_1?org=org+1");
  });

  it("pins every request to the organization the page loaded for", async () => {
    const fetch = answering(
      Response.json({ job, events: [], more: false }),
      Response.json(job),
      Response.json(job),
    );
    await readEvents(ref, 7);
    await cancelJob(ref);
    await respondToJob(ref, "input_1", { kind: "confirmation", confirmed: true });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/cloud/jobs/job_1/events?after=7&org=org+1",
      "/api/cloud/jobs/job_1/cancel?org=org+1",
      "/api/cloud/jobs/job_1/respond?org=org+1",
    ]);
    expect(fetch.mock.calls[2][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        inputId: "input_1",
        answer: { kind: "confirmation", confirmed: true },
      }),
    });
  });
});

describe("what the console answered", () => {
  it("hands back what it read", async () => {
    answering(Response.json(job));
    expect(await cancelJob(ref)).toEqual({ kind: "ok", value: job });
  });

  it("says the job is gone when the console finds none", async () => {
    answering(Response.json({ error: "Not found" }, { status: 404 }));
    expect(await cancelJob(ref)).toEqual({ kind: "gone" });
  });

  it("marks a stale input so the page reads the job again", async () => {
    answering(
      Response.json(
        { error: "This request is no longer current.", reason: "stale" },
        { status: 409 },
      ),
    );
    expect(await respondToJob(ref, "input_1", { kind: "confirmation", confirmed: false })).toEqual({
      kind: "stale",
      message: "This request is no longer current.",
    });
  });

  it("carries what Ocel Cloud said about a request it refused", async () => {
    answering(
      Response.json({ error: "OTHER was not asked for", reason: "invalid" }, { status: 400 }),
    );
    expect(await respondToJob(ref, "input_1", { kind: "confirmation", confirmed: true })).toEqual({
      kind: "failed",
      message: "OTHER was not asked for",
    });
  });

  it("has no words when the answer has none or never came", async () => {
    answering(new Response("oops", { status: 502 }), new TypeError("Failed to fetch"));
    expect(await readEvents(ref, 0)).toEqual({ kind: "failed", message: null });
    expect(await readEvents(ref, 0)).toEqual({ kind: "failed", message: null });
  });
});

describe("refusalOf", () => {
  it("says what the console said, a gone job is gone, and falls back when it said nothing", () => {
    expect(refusalOf({ kind: "failed", message: "already ended" }, "Try again.")).toBe(
      "already ended",
    );
    expect(refusalOf({ kind: "stale", message: null }, "Try again.")).toBe("Try again.");
    expect(refusalOf({ kind: "gone" }, "Try again.")).toBe("This job is gone. Reload the page.");
  });
});
