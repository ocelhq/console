import type { RunJob } from "@console/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelJob, readEvents, respondToJob } from "./job-run-client";

const ref = { of: "deployments" as const, id: "dep 1" };

const job = { id: "job_1", state: "canceled" } as RunJob;

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

describe("the run's urls", () => {
  it("reach the run of the deployment the page shows", async () => {
    const fetch = answering(
      Response.json({ job, events: [], more: false }),
      Response.json(job),
      Response.json(job),
    );
    await readEvents(ref, 7);
    await cancelJob(ref);
    await respondToJob(ref, "input_1", { confirmed: true });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/deployments/dep%201/run/events?after=7",
      "/api/deployments/dep%201/run/cancel",
      "/api/deployments/dep%201/run/respond",
    ]);
    expect(fetch.mock.calls[2][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        inputId: "input_1",
        confirmed: true,
      }),
    });
  });

  it("reaches a job that is no deployment under its own path", async () => {
    const fetch = answering(Response.json({ job, events: [], more: false }));
    await readEvents({ of: "jobs", id: "job-1" }, 0);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/jobs/job-1/run/events?after=0"]);
  });
});

describe("what the console answered", () => {
  it("hands back what it read", async () => {
    answering(Response.json(job));
    expect(await cancelJob(ref)).toEqual({ kind: "ok", value: job });
  });

  it("says the job is gone when the console finds none", async () => {
    answering(Response.json({ error: "Not found" }, { status: 404 }));
    expect(await cancelJob(ref)).toEqual({ kind: "lost", why: "gone" });
  });

  it("says the reader is signed out when the console no longer knows them", async () => {
    answering(
      Response.json({ error: "Unauthorized" }, { status: 401 }),
      Response.json({ error: "Unauthorized" }, { status: 401 }),
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const signedOut = { kind: "lost", why: "signed-out" };
    expect(await readEvents(ref, 0)).toEqual(signedOut);
    expect(await cancelJob(ref)).toEqual(signedOut);
    expect(await respondToJob(ref, "input_1", { confirmed: true })).toEqual(signedOut);
  });

  it("marks a stale input so the page reads the job again", async () => {
    answering(
      Response.json(
        { error: "This request is no longer current.", reason: "stale" },
        { status: 409 },
      ),
    );
    expect(await respondToJob(ref, "input_1", { confirmed: false })).toEqual({
      kind: "stale",
      message: "This request is no longer current.",
    });
  });

  it("carries what the runner said about a request it refused", async () => {
    answering(
      Response.json({ error: "OTHER was not asked for", reason: "invalid" }, { status: 400 }),
    );
    expect(await respondToJob(ref, "input_1", { confirmed: true })).toEqual({
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
