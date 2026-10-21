import type { CloudJob, CloudJobEvent, JobEvents } from "@console/api";
import { appendEvents, isTerminal, lastSeq, pollDelay, shouldPoll } from "./cloud-job";
import type { JobReply, Lost } from "./cloud-job-client";

export interface Feed {
  job: CloudJob;
  events: readonly CloudJobEvent[];
  polling: boolean;
  trouble: string | null;
  lost: Lost | null;
}

export interface FeedPoll {
  show(job: CloudJob): void;
  lose(why: Lost): void;
  poke(): void;
  stop(): void;
}

export function feedOf(start: JobEvents): Feed {
  return {
    job: start.job,
    events: start.events,
    polling: shouldPoll(start.job, start.more),
    trouble: null,
    lost: null,
  };
}

export function pollFeed(
  start: JobEvents,
  read: (after: number) => Promise<JobReply<JobEvents>>,
  on: { change(feed: Feed): void; ended(): void },
): FeedPoll {
  let feed = feedOf(start);
  let after = lastSeq(start.events);
  let more = start.more;
  let state = start.job.state;
  let failures = 0;
  let stopped = false;
  let busy = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function emit(next: Partial<Feed>) {
    feed = { ...feed, ...next };
    on.change(feed);
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
  }

  function lose(why: Lost) {
    stop();
    emit({ lost: why, trouble: null, polling: false });
  }

  async function tick() {
    busy = true;
    const reply = await read(after);
    busy = false;
    if (stopped) return;
    if (reply.kind === "lost") {
      lose(reply.why);
      return;
    }
    if (reply.kind === "ok") {
      const page = reply.value;
      const ended = isTerminal(page.job.state) && !isTerminal(state);
      after = Math.max(after, lastSeq(page.events));
      more = page.more;
      state = page.job.state;
      failures = 0;
      emit({ job: page.job, events: appendEvents(feed.events, page.events), trouble: null });
      if (ended) on.ended();
    } else {
      failures += 1;
      emit({ trouble: reply.message ?? "the console didn’t answer" });
    }
    if (!shouldPoll({ state }, more)) {
      emit({ polling: false });
      return;
    }
    timer = setTimeout(tick, again ? 0 : pollDelay(failures, more));
    again = false;
  }

  if (feed.polling) {
    timer = setTimeout(tick, pollDelay(0, more));
  }

  return {
    show: (job) => emit({ job }),
    lose,
    poke() {
      if (stopped || !shouldPoll({ state }, more)) return;
      if (busy) {
        again = true;
        return;
      }
      clearTimeout(timer);
      void tick();
    },
    stop,
  };
}
