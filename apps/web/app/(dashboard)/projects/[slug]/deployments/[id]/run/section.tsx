import { type JobEvents, runJobOfRow, type ShownRun } from "@console/api";
import { ValueError } from "@console/connectors";
import { phaseOf } from "@console/jobs";
import { Suspense } from "react";
import type { JobRef } from "@/lib/job-run-client";
import { RunView } from "./run-view";
import { JobGone, JobLoadError, JobLoading } from "./states";

interface Shown {
  subject: JobRef;
  run: ShownRun;
  href: string;
  now: string;
}

function Shown({ subject, run, href, now, initial }: Shown & { initial: JobEvents }) {
  return (
    <RunView
      subject={subject}
      href={href}
      runner={run.job.runnerId ?? ""}
      mayGiveValues={run.mayGiveValues}
      initial={initial}
      now={now}
    />
  );
}

async function Followed(props: Shown) {
  let answer: Awaited<ReturnType<ShownRun["run"]["events"]>>;
  try {
    answer = await props.run.run.events(0);
  } catch (thrown) {
    if (thrown instanceof ValueError && thrown.status === 404) return <JobGone />;
    throw thrown;
  }
  if (!answer.done) {
    return <JobLoadError href={props.href} message={answer.refusal.message} />;
  }
  return <Shown {...props} initial={answer.result} />;
}

export function RunSection(props: Shown) {
  if (phaseOf(props.run.job) === "ended") {
    return (
      <Shown {...props} initial={{ job: runJobOfRow(props.run.job), events: [], more: true }} />
    );
  }
  return (
    <Suspense fallback={<JobLoading />}>
      <Followed {...props} />
    </Suspense>
  );
}
