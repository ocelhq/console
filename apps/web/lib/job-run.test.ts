import type { RunJobEvent } from "@console/api";
import { describe, expect, it } from "vitest";
import {
  appendEvents,
  isTerminal,
  JOB_POLL_MS,
  lastSeq,
  logLines,
  phaseWord,
  pollDelay,
  shouldPoll,
} from "./job-run";

function event(seq: number, phase: RunJobEvent["phase"] = "build"): RunJobEvent {
  return { seq, time: null, level: "info", phase, message: `line ${seq}` };
}

describe("appendEvents", () => {
  it("adds only the events after the last one shown", () => {
    const shown = [event(1), event(2)];
    expect(appendEvents(shown, [event(2), event(3)]).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("keeps the same list when nothing is new, so nothing re-renders", () => {
    const shown = [event(1)];
    expect(appendEvents(shown, [event(1)])).toBe(shown);
    expect(appendEvents(shown, [])).toBe(shown);
  });
});

describe("lastSeq", () => {
  it("is 0 before any event, so the first poll asks from the start", () => {
    expect(lastSeq([])).toBe(0);
    expect(lastSeq([event(4), event(9)])).toBe(9);
  });
});

describe("logLines", () => {
  it("marks where each phase begins", () => {
    const lines = logLines([
      event(1, "check"),
      event(2, "build"),
      event(3, null),
      event(4, "build"),
    ]);
    expect(
      lines.map((line) => (line.kind === "phase" ? `# ${line.phase}` : line.event.seq)),
    ).toEqual(["# check", 1, "# build", 2, 3, 4]);
  });
});

describe("polling", () => {
  it("stops at a terminal state once every event is read", () => {
    expect(shouldPoll({ state: "running" }, false)).toBe(true);
    expect(shouldPoll({ state: "input-required" }, false)).toBe(true);
    expect(shouldPoll({ state: "succeeded" }, true)).toBe(true);
    for (const state of ["succeeded", "failed", "canceled"] as const) {
      expect(isTerminal(state)).toBe(true);
      expect(shouldPoll({ state }, false)).toBe(false);
    }
  });

  it("asks again at once while the runner holds more, and backs off after a failure", () => {
    expect(pollDelay(0, false)).toBe(JOB_POLL_MS);
    expect(pollDelay(0, true)).toBe(0);
    expect(pollDelay(1, true)).toBe(JOB_POLL_MS * 2);
    expect(pollDelay(10, false)).toBe(15_000);
  });
});

describe("phaseWord", () => {
  it("names the phase a destroy job runs in", () => {
    expect(phaseWord("destroy")).toBe("Destroy");
  });
});
