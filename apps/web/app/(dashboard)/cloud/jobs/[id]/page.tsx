import { cloudJobsFor, JOB_ID, mayGiveValues } from "@console/api";
import { notFound } from "next/navigation";
import { requireCloudCaller, requireOrganization } from "@/lib/access";
import { jobHref } from "@/lib/cloud-job-client";
import { placeOf } from "@/lib/cloud-job-place";
import { JobView } from "./job-view";
import { JobLoadError } from "./states";

export default async function CloudJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ org?: string | string[] }>;
}) {
  const [{ id }, { org }] = await Promise.all([params, searchParams]);
  const caller = await requireCloudCaller(typeof org === "string" ? org : null);
  if (!JOB_ID.test(id)) {
    notFound();
  }
  const jobs = cloudJobsFor(caller);
  if (!jobs) {
    notFound();
  }

  const answer = await jobs.events(id, 0);
  if (!answer.ok) {
    if (answer.reason === "not-found") {
      notFound();
    }
    return (
      <JobLoadError
        href={jobHref({ id, organizationId: caller.organizationId })}
        message={answer.message}
      />
    );
  }

  const { activeOrganizationId } = await requireOrganization();
  const place = await placeOf(caller.organizationId, activeOrganizationId, answer.result.job);
  return (
    <JobView
      organizationId={caller.organizationId}
      mayGiveValues={mayGiveValues(caller.role)}
      initial={answer.result}
      place={place}
      now={new Date().toISOString()}
    />
  );
}
