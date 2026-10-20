import { cloudJobsFor, JOB_ID } from "@console/api";
import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/access";
import { jobHref } from "@/lib/cloud-job";
import { placeOf } from "@/lib/cloud-job-place";
import { JobView } from "./job-view";
import { JobLoadError } from "./states";

export default async function CloudJobPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, session] = await Promise.all([params, requireOrganization()]);
  if (!JOB_ID.test(id)) {
    notFound();
  }
  const jobs = cloudJobsFor(session);
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

  const place = await placeOf(session.activeOrganizationId, answer.result.job);
  return <JobView initial={answer.result} place={place} now={new Date().toISOString()} />;
}
