import type { JobEvents, RunJob, RunJobEvent } from "@console/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobReply } from "./job-run-client";
import { type Feed, pollFeed } from "./job-run-feed";

function job(state: RunJob["state"]): RunJob {
  return {
    id: "job_1",
    projectId: "project-1",
    state,
    phase: null,
    step: "",
    createdAt: "2026-10-20T10:00:00.000Z",
    startedAt: null,
    endedAt: null,
    error: null,
    result: null,
    deploymentId: "",
    input: null,
  };
}

function event(seq: number): RunJobEvent {
  return { seq, time: null, level: "info", phase: null, message: `line ${seq}` };
}

function page(state: RunJob["state"], seqs: number[], more = false): JobReply<JobEvents> {
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

  it("keeps paging at once while the runner holds more, even once the job has ended", async () => {
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
      { kind: "failed", message: "the runner is unreachable" },
      { kind: "failed", message: null },
      page("running", [2]),
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(feed()?.trouble).toBe("the runner is unreachable");
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

  it("reads an ended job's log once, and gives up rather than retry a runner that fails", async () => {
    const { read, feed } = polling(
      { job: job("succeeded"), events: [], more: true },
      { kind: "failed", message: "the runner is unreachable" },
    );
    await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledOnce();
    expect(feed()?.trouble).toBe("the runner is unreachable");
    expect(feed()?.polling).toBe(false);
  });

  it("stops for good once the job is gone", async () => {
    const { read, feed } = polling(running, { kind: "lost", why: "gone" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(feed()?.lost).toBe("gone");
    expect(feed()?.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledOnce();
  });

  it("stops for good once the reader is signed out, rather than retrying", async () => {
    const { read, feed } = polling(running, { kind: "lost", why: "signed-out" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(feed()?.lost).toBe("signed-out");
    expect(feed()?.trouble).toBeNull();
    expect(feed()?.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledOnce();
  });

  it("stops when a cancel or an answer finds the job lost", async () => {
    const { read, poll, feed } = polling(running);
    poll.lose("signed-out");
    expect(feed()?.lost).toBe("signed-out");
    expect(feed()?.polling).toBe(false);
    poll.poke();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).not.toHaveBeenCalled();
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
