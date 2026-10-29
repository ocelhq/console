import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY, type Fetch, fetchOk, HttpError, type RetryPolicy } from "./http";

function scripted(answers: (Response | Error)[]): { fetcher: Fetch; calls: () => number } {
  let calls = 0;
  return {
    fetcher: async () => {
      const answer = answers[calls];
      calls += 1;
      if (!answer) throw new Error("no more answers");
      if (answer instanceof Error) throw answer;
      return answer;
    },
    calls: () => calls,
  };
}

function policy(slept: number[]): RetryPolicy {
  return {
    ...DEFAULT_RETRY,
    attempts: 4,
    minDelayMs: 100,
    maxDelayMs: 5_000,
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => 1,
  };
}

describe("fetchOk", () => {
  it("retries a 5xx and a network failure with growing backoff", async () => {
    const slept: number[] = [];
    const { fetcher, calls } = scripted([
      new Response("busy", { status: 503 }),
      new TypeError("fetch failed"),
      new Response("ok"),
    ]);
    const response = await fetchOk(fetcher, "https://x.test/a", {}, policy(slept));
    expect(await response.text()).toBe("ok");
    expect(calls()).toBe(3);
    expect(slept).toEqual([100, 200]);
  });

  it("honours Retry-After on a 429", async () => {
    const slept: number[] = [];
    const { fetcher } = scripted([
      new Response("slow down", { status: 429, headers: { "retry-after": "3" } }),
      new Response("ok"),
    ]);
    await fetchOk(fetcher, "https://x.test/a", {}, policy(slept));
    expect(slept).toEqual([3000]);
  });

  it("gives up at once on a 4xx other than 429", async () => {
    const slept: number[] = [];
    const { fetcher, calls } = scripted([new Response("denied", { status: 403 })]);
    await expect(fetchOk(fetcher, "https://x.test/a", {}, policy(slept))).rejects.toThrow(
      HttpError,
    );
    expect(calls()).toBe(1);
    expect(slept).toEqual([]);
  });

  it("gives up after its attempts, and when Retry-After is past its ceiling", async () => {
    const slept: number[] = [];
    const failing = scripted(Array.from({ length: 4 }, () => new Response("", { status: 500 })));
    await expect(fetchOk(failing.fetcher, "https://x.test/a", {}, policy(slept))).rejects.toThrow(
      /answered 500/,
    );
    expect(failing.calls()).toBe(4);

    const patient = scripted([
      new Response("", { status: 429, headers: { "retry-after": "3600" } }),
    ]);
    await expect(fetchOk(patient.fetcher, "https://x.test/a", {}, policy([]))).rejects.toThrow(
      /answered 429/,
    );
    expect(patient.calls()).toBe(1);
  });
});
