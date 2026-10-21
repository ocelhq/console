import type { CloudJob, CloudJobEvent, JobEvents } from "@console/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobReply } from "./cloud-job-client";
import { type Feed, pollFeed } from "./cloud-job-feed";

function job(state: CloudJob["state"]): CloudJob {
  return {
    id: "job_1",
    projectId: "project-1",
    command: "deploy",
    state,
    phase: null,
    step: "",
    createdAt: "2026-10-20T10:00:00.000Z",
    startedAt: null,
    endedAt: null,
    error: null,
    result: null,
    sourceId: "a",
    input: null,
  };
}

function event(seq: number): CloudJobEvent {
  return { seq, time: null, level: "info", phase: null, message: `line ${seq}` };
}

function page(state: CloudJob["state"], seqs: number[], more = false): JobReply<JobEvents> {
  return { kind: "ok", value: { job: job(state), events: seqs.map(event), more } };
}

function polling(start: JobEvents, ...replies: JobReply<JobEvents>[]) {
  const read = vi.fn(async (_after: number) => replies.shift() ?? page("running", []));
  const ended = vi.fn();
  let feed: Feed | null = null;
  const poll = pollFeed(start, read, {
    change: (next) => {
      feed = next;
    },
    ended,
  });
  return { read, ended, poll, feed: () => feed };
}

const running: JobEvents = { job: job("running"), events: [event(1)], more: false };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pollFeed", () => {
  it("polls until the job ends, refreshing the page once when it does", async () => {
    const { read, ended, feed } = polling(running, page("running", [2]), page("succeeded", [3]));
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenLastCalledWith(1);
    expect(feed()?.events.map((e) => e.seq)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenLastCalledWith(2);
    expect(feed()?.job.state).toBe("succeeded");
    expect(feed()?.polling).toBe(false);
    expect(ended).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps paging at once while Ocel Cloud holds more, even once the job has ended", async () => {
    const { read, ended, feed } = polling(
      { job: job("succeeded"), events: [event(1)], more: true },
      page("succeeded", [2], true),
      page("succeeded", [3]),
    );
    await vi.runAllTimersAsync();
    expect(read.mock.calls.map(([after]) => after)).toEqual([1, 2]);
    expect(feed()?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(feed()?.polling).toBe(false);
    expect(ended).not.toHaveBeenCalled();
  });

  it("backs off after a failure, saying so, and clears the trouble once it reads again", async () => {
    const { read, feed } = polling(
      running,
      { kind: "failed", message: "Ocel Cloud is unreachable" },
      { kind: "failed", message: null },
      page("running", [2]),
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(feed()?.trouble).toBe("Ocel Cloud is unreachable");
    expect(feed()?.polling).toBe(true);
    await vi.advanceTimersByTimeAsync(2999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(feed()?.trouble).toBe("the console didn’t answer");
    await vi.advanceTimersByTimeAsync(6000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(feed()?.trouble).toBeNull();
  });

  it("stops for good once the job is gone", async () => {
    const { read, feed } = polling(running, { kind: "gone" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(feed()?.gone).toBe(true);
    expect(feed()?.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledOnce();
  });

  it("reads nothing more once stopped, even with a read in flight", async () => {
    const { read, poll, feed } = polling(running, page("running", [2]));
    poll.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).not.toHaveBeenCalled();

    const second = polling(running, page("running", [2]));
    await vi.advanceTimersByTimeAsync(1499);
    second.poll.poke();
    second.poll.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(second.read).toHaveBeenCalledOnce();
    expect(second.feed()).toBeNull();
    expect(feed()).toBeNull();
  });

  it("reads at once when poked, and again right after a read in flight", async () => {
    const { read, poll } = polling(running, page("running", [2]), page("running", [3]));
    poll.poke();
    poll.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map(([after]) => after)).toEqual([1, 2]);
  });

  it("shows a job the page was handed without moving the poll on", async () => {
    const { read, poll, feed } = polling(running, page("canceled", []));
    poll.show(job("canceled"));
    expect(feed()?.job.state).toBe("canceled");
    expect(feed()?.polling).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledOnce();
  });
});
