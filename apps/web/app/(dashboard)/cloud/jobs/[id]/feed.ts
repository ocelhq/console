"use client";

import type { CloudJob, CloudJobEvent, JobEvents } from "@console/api";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { appendEvents, isTerminal, lastSeq, pollDelay, shouldPoll } from "@/lib/cloud-job";
import { type JobRef, readEvents } from "@/lib/cloud-job-client";

export interface Feed {
  job: CloudJob;
  events: readonly CloudJobEvent[];
  polling: boolean;
  trouble: string | null;
  gone: boolean;
}

export interface FeedControls {
  show(job: CloudJob): void;
  refresh(): void;
}

export function useJobFeed(ref: JobRef, initial: JobEvents): Feed & FeedControls {
  const router = useRouter();
  const start = useRef({ ref, initial });
  const [job, setJob] = useState(initial.job);
  const [events, setEvents] = useState<readonly CloudJobEvent[]>(initial.events);
  const [polling, setPolling] = useState(shouldPoll(initial.job, initial.more));
  const [trouble, setTrouble] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const poke = useRef<() => void>(() => {});

  useEffect(() => {
    const {
      ref,
      initial: { job: first, events: shown, more: firstMore },
    } = start.current;
    let after = lastSeq(shown);
    let more = firstMore;
    let state = first.state;
    let failures = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let again = false;

    async function tick() {
      busy = true;
      const reply = await readEvents(ref, after);
      if (stopped) return;
      if (reply.kind === "gone") {
        setGone(true);
        setPolling(false);
        return;
      }
      if (reply.kind === "ok") {
        const page = reply.value;
        const ended = isTerminal(page.job.state) && !isTerminal(state);
        after = Math.max(after, lastSeq(page.events));
        more = page.more;
        state = page.job.state;
        failures = 0;
        setJob(page.job);
        setEvents((current) => appendEvents(current, page.events));
        setTrouble(null);
        if (ended) {
          router.refresh();
        }
      } else {
        failures += 1;
        setTrouble(reply.message ?? "the console didn’t answer");
      }
      busy = false;
      if (stopped) return;
      if (!shouldPoll({ state }, more)) {
        setPolling(false);
        return;
      }
      timer = setTimeout(tick, again ? 0 : pollDelay(failures, more));
      again = false;
    }

    poke.current = () => {
      if (stopped || !shouldPoll({ state }, more)) return;
      if (busy) {
        again = true;
        return;
      }
      clearTimeout(timer);
      void tick();
    };

    if (shouldPoll(first, firstMore)) {
      timer = setTimeout(tick, pollDelay(0, firstMore));
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
      poke.current = () => {};
    };
  }, [router]);

  return { job, events, polling, trouble, gone, show: setJob, refresh: () => poke.current() };
}
