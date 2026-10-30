"use client";

import type { JobEventLevelName, RunJobEvent } from "@console/api";
import { ArrowDownIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { clockOf, logLines, phaseWord } from "@/lib/job-run";
import { absoluteTime } from "@/lib/relative-time";
import { labelType } from "@/lib/type";

const levels: Record<JobEventLevelName, { className: string; spoken: string | null }> = {
  debug: { className: "text-terminal-foreground/70", spoken: "debug" },
  info: { className: "text-terminal-ink", spoken: null },
  warn: { className: "text-warn", spoken: "warning" },
  error: { className: "text-destructive", spoken: "error" },
};

const pinSlack = 24;

export function JobLog({
  events,
  polling,
  trouble,
  ended,
}: {
  events: readonly RunJobEvent[];
  polling: boolean;
  trouble: string | null;
  ended: boolean;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const lines = logLines(events);
  const count = events.length;

  useLayoutEffect(() => {
    const element = pane.current;
    if (!element) return;
    if (pinned.current) {
      element.scrollTop = element.scrollHeight;
    } else if (count > 0) {
      setUnseen(true);
    }
  }, [count]);

  function onScroll() {
    const element = pane.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= pinSlack;
    if (pinned.current) {
      setUnseen(false);
    }
  }

  function jump() {
    const element = pane.current;
    if (!element) return;
    pinned.current = true;
    setUnseen(false);
    element.scrollTop = element.scrollHeight;
  }

  return (
    <section aria-labelledby="job-log" className="flex flex-col border border-border">
      <div className="flex h-10 items-center justify-between gap-3 border-b border-border px-4">
        <h2 id="job-log" className={labelType}>
          Log
        </h2>
        <span className="flex items-center gap-3 text-xs text-muted-foreground">
          {trouble ? (
            <span role="status" className="text-warn">
              Lost touch with the runner, retrying: {trouble}
            </span>
          ) : polling ? (
            <span role="status" className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 animate-pulse rounded-full bg-faint" />
              Following
            </span>
          ) : null}
          <span>
            {count} {count === 1 ? "line" : "lines"}
          </span>
        </span>
      </div>
      <div className="relative">
        <div
          ref={pane}
          onScroll={onScroll}
          role="log"
          aria-live="off"
          aria-label="Job log"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling log takes focus so a keyboard can scroll it
          tabIndex={0}
          className="dark h-[32rem] overflow-auto bg-terminal px-4 py-3 font-mono text-xs leading-5 outline-none focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          {lines.length === 0 ? (
            <p className="text-terminal-foreground">
              {ended ? "This job reported no output." : "No output yet."}
            </p>
          ) : (
            lines.map((line) =>
              line.kind === "phase" ? (
                <p key={line.key} className="mt-2 text-terminal-foreground/60 first:mt-0">
                  # {phaseWord(line.phase)?.toLowerCase()}
                </p>
              ) : (
                <p
                  key={line.key}
                  className={`flex gap-3 whitespace-pre-wrap break-words ${levels[line.event.level].className}`}
                >
                  {line.event.time && (
                    <time
                      dateTime={line.event.time}
                      title={absoluteTime(line.event.time)}
                      className="shrink-0 text-terminal-foreground/60 tabular-nums"
                    >
                      {clockOf(line.event.time)}
                    </time>
                  )}
                  <span className="min-w-0">
                    {levels[line.event.level].spoken && (
                      <span className="sr-only">{levels[line.event.level].spoken}: </span>
                    )}
                    {line.event.message}
                  </span>
                </p>
              ),
            )
          )}
        </div>
        {unseen && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={jump}
            className="absolute right-4 bottom-3"
          >
            <ArrowDownIcon data-icon="inline-start" />
            Latest
          </Button>
        )}
      </div>
    </section>
  );
}
