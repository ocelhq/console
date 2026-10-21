"use client";

import type { CloudJob, JobEvents } from "@console/api";
import { ArrowLeftIcon, ArrowSquareOutIcon, TerminalIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { commandOf, isTerminal, type JobTone, phaseWord, stateOf, titleOf } from "@/lib/cloud-job";
import type { JobPlace } from "@/lib/cloud-job-place";
import { spanOf } from "@/lib/deployment-view";
import { absoluteTime } from "@/lib/relative-time";
import { labelType } from "@/lib/type";
import { cn } from "@/lib/utils";
import { Cell, Field, Joined, NotReported, Panel } from "../../../panels";
import { Stamp } from "../../../stamp";
import { CancelJob } from "./cancel";
import { useJobFeed } from "./feed";
import { InputRequired } from "./input";
import { JobLog } from "./log";
import { JobGone } from "./states";

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

export function JobStatus({ job }: { job: Pick<CloudJob, "state"> }) {
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

function Result({ job, deploymentHref }: { job: CloudJob; deploymentHref: string | null }) {
  const result = job.result;
  if (!result) {
    return null;
  }
  const { urls, builds, deploymentId } = result;
  if (urls.length === 0 && builds.length === 0 && !deploymentId) {
    return null;
  }
  return (
    <Joined className="md:grid-cols-3">
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
      <Panel heading="Deployment">
        {!deploymentId ? (
          <NotReported />
        ) : deploymentHref ? (
          <Link
            href={deploymentHref}
            className="font-mono text-xs break-all underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            {deploymentId}
          </Link>
        ) : (
          <span className="flex flex-col gap-1">
            <span className="font-mono text-xs break-all">{deploymentId}</span>
            <span className="text-xs text-muted-foreground">Not reported to this console yet.</span>
          </span>
        )}
      </Panel>
    </Joined>
  );
}

export function JobView({
  initial,
  place,
  now,
}: {
  initial: JobEvents;
  place: JobPlace;
  now: string;
}) {
  const feed = useJobFeed(initial);
  const { job } = feed;
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const ended = isTerminal(job.state);
  const at = useNow(!ended && job.startedAt !== null, now);
  const command = commandOf(job.command);
  const phase = phaseWord(job.phase);
  const took = job.startedAt
    ? spanOf(Date.parse(job.startedAt), job.endedAt ? Date.parse(job.endedAt) : at)
    : null;

  if (feed.gone) {
    return <JobGone />;
  }

  return (
    <div className="flex flex-1 flex-col gap-6 px-5 pt-8 pb-12 md:px-8">
      <header className="flex flex-col gap-4">
        {place.project ? (
          <Link
            href={`/projects/${place.project.slug}/deployments`}
            className={`${labelType} inline-flex w-fit items-center gap-1.5 underline-offset-4 outline-none hover:underline focus-visible:underline`}
          >
            <ArrowLeftIcon aria-hidden className="size-3.5" />
            {place.project.name}
          </Link>
        ) : (
          <span className={labelType}>Ocel Cloud job</span>
        )}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="flex flex-col gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {titleOf(job.command)}
              {place.project && (
                <span className="text-muted-foreground"> · {place.project.name}</span>
              )}
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
              <JobStatus job={job} />
              {(job.startedAt ?? job.createdAt) && (
                <span className="text-muted-foreground">
                  <Stamp
                    at={(job.startedAt ?? job.createdAt) as string}
                    now={now}
                    prefix={job.startedAt ? "Started" : "Queued"}
                  />
                </span>
              )}
            </div>
            {!ended && (job.step || phase) && (
              <p aria-live="polite" className="text-sm">
                {phase && <span className="text-muted-foreground">{phase} · </span>}
                {job.step}
              </p>
            )}
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
          {!ended && <CancelJob id={job.id} onCanceled={feed.show} />}
        </div>
      </header>

      {job.state === "input-required" && (
        <InputRequired
          job={job}
          sent={job.input !== null && answered.has(job.input.id)}
          onAnswered={(inputId, next) => {
            setAnswered((current) => new Set(current).add(inputId));
            feed.show(next);
            feed.refresh();
          }}
          onStale={feed.refresh}
        />
      )}

      <Joined className="sm:grid-cols-2 lg:grid-cols-3">
        <Field name="Command">
          {command ? (
            <span className="inline-flex items-center gap-1.5">
              <TerminalIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-mono text-[13px]">{command}</span>
            </span>
          ) : (
            <NotReported />
          )}
        </Field>
        <Field name="Project">
          {place.project ? (
            <Link
              href={`/projects/${place.project.slug}`}
              className="underline-offset-4 outline-none hover:underline focus-visible:underline"
            >
              {place.project.name}
            </Link>
          ) : (
            <span className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">Not in this organization</span>
              <span className="font-mono text-xs break-all text-muted-foreground">
                {job.projectId}
              </span>
            </span>
          )}
        </Field>
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
          {job.sourceId && <span title={job.sourceId}>source {job.sourceId.slice(0, 12)}</span>}
        </Cell>
      </Joined>

      <Result job={job} deploymentHref={place.deploymentHref} />

      <JobLog events={feed.events} polling={feed.polling} trouble={feed.trouble} ended={ended} />
    </div>
  );
}
