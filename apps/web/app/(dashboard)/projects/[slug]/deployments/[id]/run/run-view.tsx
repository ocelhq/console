"use client";

import type { JobEvents, RunJob } from "@console/api";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { spanOf } from "@/lib/deployment-view";
import { isTerminal, type JobTone, phaseWord, stateOf } from "@/lib/job-run";
import type { JobRef } from "@/lib/job-run-client";
import { absoluteTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { Cell, Field, Joined, NotReported, Panel } from "../../../../../panels";
import { CancelJob } from "./cancel";
import { useJobFeed } from "./feed";
import { InputRequired } from "./input";
import { JobLog } from "./log";
import { JobGone, JobSignedOut } from "./states";

const dots: Record<JobTone, string> = {
  go: "bg-go",
  faint: "bg-faint",
  destructive: "bg-destructive",
  warn: "bg-faint",
};

const words: Record<JobTone, string> = {
  go: "",
  faint: "",
  destructive: "text-destructive",
  warn: "text-warn",
};

function useNow(ticking: boolean, now: string): number {
  const [at, setAt] = useState(() => Date.parse(now));
  useEffect(() => {
    if (!ticking) return;
    setAt(Date.now());
    const timer = setInterval(() => setAt(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return at;
}

export function JobStatus({ job }: { job: Pick<RunJob, "state"> }) {
  const state = stateOf(job.state);
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          dots[state.tone],
          state.live && "animate-pulse",
        )}
      />
      <span className={words[state.tone]}>{state.word}</span>
    </span>
  );
}

function Result({ job }: { job: RunJob }) {
  const result = job.result;
  if (!result || (result.urls.length === 0 && result.builds.length === 0)) {
    return null;
  }
  const { urls, builds } = result;
  return (
    <Joined className="md:grid-cols-2">
      <Panel heading="Urls">
        {urls.length === 0 ? (
          <NotReported />
        ) : (
          <ul className="flex flex-col gap-2">
            {urls.map((url) => (
              <li key={url}>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs break-all underline-offset-4 outline-none hover:underline focus-visible:underline"
                >
                  {url.replace(/^https?:\/\//, "")}
                  <ArrowSquareOutIcon
                    aria-hidden
                    className="size-3 shrink-0 text-muted-foreground"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel heading="Builds">
        {builds.length === 0 ? (
          <NotReported />
        ) : (
          <ul className="flex flex-col gap-2">
            {builds.map((build) => (
              <li key={build.app} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-semibold">{build.app}</span>
                <span className="font-mono text-xs break-all text-muted-foreground">
                  {build.buildId}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Joined>
  );
}

export function RunView({
  subject,
  href,
  runner,
  mayGiveValues,
  initial,
  now,
}: {
  subject: JobRef;
  href: string;
  runner: string;
  mayGiveValues: boolean;
  initial: JobEvents;
  now: string;
}) {
  const ref = subject;
  const feed = useJobFeed(ref, initial);
  const { job } = feed;
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const ended = isTerminal(job.state);
  const at = useNow(!ended && job.startedAt !== null, now);
  const phase = phaseWord(job.phase);
  const took = job.startedAt
    ? spanOf(Date.parse(job.startedAt), job.endedAt ? Date.parse(job.endedAt) : at)
    : null;

  if (feed.lost === "gone") {
    return <JobGone />;
  }
  if (feed.lost === "signed-out") {
    return <JobSignedOut href={href} />;
  }

  return (
    <section aria-labelledby="run" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex flex-col gap-3">
          <h2 id="run" className="text-lg font-semibold tracking-tight">
            Run
          </h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <JobStatus job={job} />
            {!ended && (job.step || phase) && (
              <p aria-live="polite">
                {phase && <span className="text-muted-foreground">{phase} · </span>}
                {job.step}
              </p>
            )}
          </div>
          {job.state === "failed" && job.error && (
            <div
              role="alert"
              className="flex max-w-xl flex-col gap-1 border border-destructive p-3 text-destructive"
            >
              {job.error.code && (
                <span className="font-mono text-xs font-medium">{job.error.code}</span>
              )}
              <p className="font-mono text-xs whitespace-pre-wrap">{job.error.message}</p>
            </div>
          )}
        </div>
        {!ended && <CancelJob job={ref} onCanceled={feed.show} onLost={feed.lose} />}
      </div>

      {job.state === "input-required" && (
        <InputRequired
          input={job.input}
          sent={job.input !== null && answered.has(job.input.id)}
          mayGiveValues={mayGiveValues}
          answering={{
            job: ref,
            onAnswered: (inputId, next) => {
              setAnswered((current) => new Set(current).add(inputId));
              feed.show(next);
              feed.refresh();
            },
            onStale: feed.refresh,
            onLost: feed.lose,
          }}
        />
      )}

      <Joined className="sm:grid-cols-2 lg:grid-cols-4">
        <Field name="Phase">{phase ?? <NotReported />}</Field>
        <Field name="Queued">{job.createdAt ? absoluteTime(job.createdAt) : <NotReported />}</Field>
        <Field name="Started">
          {job.startedAt ? absoluteTime(job.startedAt) : <NotReported />}
        </Field>
        <Field name="Duration">
          {took ? (
            <span className="flex flex-col gap-0.5">
              <span className="tabular-nums">{took}</span>
              {job.endedAt && (
                <span className="text-xs text-muted-foreground">
                  Ended {absoluteTime(job.endedAt)}
                </span>
              )}
            </span>
          ) : (
            <NotReported />
          )}
        </Field>
        <Cell className="col-span-full flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-muted-foreground">
          <span className="break-all">job {job.id}</span>
          <span className="break-all">runner {runner}</span>
        </Cell>
      </Joined>

      <Result job={job} />

      <JobLog events={feed.events} polling={feed.polling} trouble={feed.trouble} ended={ended} />
    </section>
  );
}
