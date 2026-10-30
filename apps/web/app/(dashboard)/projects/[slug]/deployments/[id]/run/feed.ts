"use client";

import type { JobEvents, RunJob } from "@console/api";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { type JobRef, type Lost, readEvents } from "@/lib/job-run-client";
import { type Feed, type FeedPoll, feedOf, pollFeed } from "@/lib/job-run-feed";

export function useJobFeed(
  ref: JobRef,
  initial: JobEvents,
): Feed & { show(job: RunJob): void; lose(why: Lost): void; refresh(): void } {
  const router = useRouter();
  const start = useRef({ ref, initial });
  const [feed, setFeed] = useState(() => feedOf(initial));
  const poll = useRef<FeedPoll | null>(null);

  useEffect(() => {
    const { ref, initial } = start.current;
    const running = pollFeed(initial, (after) => readEvents(ref, after), {
      change: setFeed,
      ended: () => router.refresh(),
    });
    poll.current = running;
    return () => {
      running.stop();
      poll.current = null;
    };
  }, [router]);

  return {
    ...feed,
    show: (job) => poll.current?.show(job),
    lose: (why) => poll.current?.lose(why),
    refresh: () => poll.current?.poke(),
  };
}
