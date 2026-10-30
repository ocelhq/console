import { runJobOfRow, runOfJob } from "@console/api";
import { jobDeps } from "@console/jobs/tasks";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMember, requireOrganization } from "@/lib/access";
import { activityHref, activityJob, activityTitle } from "@/lib/job-activity";
import { stateOf } from "@/lib/job-run";
import { withTier } from "@/lib/tier";
import { labelType } from "@/lib/type";
import { viewedProject } from "@/lib/viewed-project";
import { Stamp } from "../../../../stamp";
import { RunSection } from "../../deployments/[id]/run/section";
import { EnvironmentBadge } from "../../deployments/cells";

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ org?: string | string[] }>;
}) {
  const [{ slug, id }, { org }, session] = await Promise.all([
    params,
    searchParams,
    requireOrganization(),
  ]);
  const found = await viewedProject(
    session,
    { slug },
    typeof org === "string" && org !== "" ? org : undefined,
  );
  const row = found && (await activityJob(found.id, id));
  if (!found || !row) {
    notFound();
  }
  const member = await requireMember(found.viewer.activeOrganizationId);
  const run = await runOfJob(row.id, member, jobDeps());
  if (!run) {
    notFound();
  }
  const now = new Date().toISOString();
  const state = stateOf(runJobOfRow(row).state);
  const back = withTier(`/projects/${slug}`, row.tier);

  return (
    <div className="flex flex-1 flex-col gap-6 px-5 pt-8 pb-12 md:px-8">
      <header className="flex flex-col gap-4">
        <Link
          href={back}
          className={`${labelType} inline-flex w-fit items-center gap-1.5 underline-offset-4 outline-none hover:underline focus-visible:underline`}
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Overview
        </Link>
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{activityTitle(row)}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span>{state.word}</span>
            <span className="text-muted-foreground">
              <Stamp at={(row.finishedAt ?? row.createdAt).toISOString()} now={now} />
            </span>
            <EnvironmentBadge tier={row.tier} active={false} />
          </div>
        </div>
      </header>
      <RunSection
        subject={{ of: "jobs", id: row.id }}
        run={run}
        href={activityHref(slug, row.id)}
        now={now}
      />
    </div>
  );
}
