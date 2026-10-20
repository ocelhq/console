"use client";

import type { CloudJob, CloudJobEvent, JobEvents } from "@console/api";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { appendEvents, isTerminal, lastSeq, pollDelay, shouldPoll } from "@/lib/cloud-job";

export interface Feed {
  job: CloudJob;
  events: readonly CloudJobEvent[];
  polling: boolean;
  trouble: string | null;
  gone: boolean;
}

export function eventsURL(id: string, after: number): string {
  return `/api/cloud/jobs/${encodeURIComponent(id)}/events?after=${after}`;
}

async function troubleOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `The console answered ${response.status}`;
}

export function useJobFeed(initial: JobEvents): Feed & { show(job: CloudJob): void } {
  const router = useRouter();
  const start = useRef(initial);
  const [job, setJob] = useState(initial.job);
  const [events, setEvents] = useState<readonly CloudJobEvent[]>(initial.events);
  const [polling, setPolling] = useState(shouldPoll(initial.job, initial.more));
  const [trouble, setTrouble] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const { job: first, events: shown, more: firstMore } = start.current;
    const id = first.id;
    let after = lastSeq(shown);
    let more = firstMore;
    let state = first.state;
    let failures = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const response = await fetch(eventsURL(id, after), { cache: "no-store" });
        if (stopped) return;
        if (response.status === 404) {
          setGone(true);
          setPolling(false);
          return;
        }
        if (!response.ok) {
          throw new Error(await troubleOf(response));
        }
        const page = (await response.json()) as JobEvents;
        if (stopped) return;
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
      } catch (thrown) {
        if (stopped) return;
        failures += 1;
        setTrouble(thrown instanceof Error ? thrown.message : String(thrown));
      }
      if (!shouldPoll({ state }, more)) {
        setPolling(false);
        return;
      }
      timer = setTimeout(tick, pollDelay(failures, more));
    }

    if (shouldPoll(first, firstMore)) {
      timer = setTimeout(tick, pollDelay(0, firstMore));
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [router]);

  return { job, events, polling, trouble, gone, show: setJob };
}
