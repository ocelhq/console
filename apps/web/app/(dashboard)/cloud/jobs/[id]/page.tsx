import { cloudJobsFor, JOB_ID } from "@console/api";
import { notFound } from "next/navigation";
import { requireCloudCaller } from "@/lib/access";
import { jobHref } from "@/lib/cloud-job";
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
    return <JobLoadError href={jobHref(id)} message={answer.message} />;
  }

  const place = await placeOf(caller.organizationId, answer.result.job);
  return <JobView initial={answer.result} place={place} now={new Date().toISOString()} />;
}
