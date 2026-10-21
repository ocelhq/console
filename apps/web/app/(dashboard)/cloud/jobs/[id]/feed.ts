"use client";

import type { CloudJob, JobEvents } from "@console/api";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { type JobRef, readEvents } from "@/lib/cloud-job-client";
import { type Feed, type FeedPoll, feedOf, pollFeed } from "@/lib/cloud-job-feed";

export function useJobFeed(
  ref: JobRef,
  initial: JobEvents,
): Feed & { show(job: CloudJob): void; refresh(): void } {
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
    refresh: () => poll.current?.poke(),
  };
}
