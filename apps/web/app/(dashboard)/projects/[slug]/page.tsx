import { db } from "@console/db";
import { type Deployment, project } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireOrganization } from "@/lib/access";
import { type Ended, latestDeployments } from "@/lib/deployments";
import { jobActivity } from "@/lib/job-activity";
import { tierOf, withTier } from "@/lib/tier";
import { JobActivity } from "./overview/activity";
import type { Provenance } from "./overview/provenance";
import { ServiceMap } from "./overview/service-map";
import { LoadError, NeverDeployed, TornDown } from "./overview/states";

function Framed({ activity, children }: { activity: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-[calc(100svh-3.5rem)] flex-col">
      {activity}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function provenanceOf(record: Ended<Deployment>): Provenance {
  return {
    deployedAt: record.deployedAt.toISOString(),
    promotionId: record.promotionId,
    tag: record.tag,
    providerName: record.providerName,
    providerRegion: record.providerRegion,
  };
}

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [{ slug }, query, session] = await Promise.all([
    params,
    searchParams,
    requireOrganization(),
  ]);
  const tier = tierOf(typeof query.env === "string" ? query.env : null);

  const [found] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.organizationId, session.activeOrganizationId), eq(project.slug, slug)));

  if (!found) {
    notFound();
  }

  const [load, rows] = await Promise.all([
    latestDeployments(found.id, tier),
    jobActivity(found.id, tier, new Date()),
  ]);
  const now = new Date().toISOString();
  const activity = <JobActivity rows={rows} slug={slug} now={now} />;

  if (load.error) {
    return (
      <Framed activity={activity}>
        <LoadError href={withTier(`/projects/${slug}`, tier)} />
      </Framed>
    );
  }

  const { latest, lastPromoted, tornDownAt } = load;

  if (!latest) {
    return (
      <Framed activity={activity}>
        <NeverDeployed tier={tier} now={now} />
      </Framed>
    );
  }

  if (tornDownAt) {
    const stamp: Provenance = {
      deployedAt: tornDownAt.toISOString(),
      promotionId: null,
      tag: null,
      providerName: latest.providerName,
      providerRegion: latest.providerRegion,
    };
    return (
      <Framed activity={activity}>
        {lastPromoted ? (
          <TornDown topology={lastPromoted.topology} provenance={stamp} now={now} />
        ) : (
          <NeverDeployed tier={tier} stamp={stamp} now={now} />
        )}
      </Framed>
    );
  }

  if (latest.outcome === "failed") {
    const failure = { deployedAt: latest.deployedAt.toISOString(), error: latest.error };
    return (
      <Framed activity={activity}>
        {lastPromoted ? (
          <ServiceMap
            topology={lastPromoted.topology}
            provenance={provenanceOf(lastPromoted)}
            failure={failure}
            now={now}
          />
        ) : (
          <NeverDeployed tier={tier} failure={failure} now={now} />
        )}
      </Framed>
    );
  }

  return (
    <Framed activity={activity}>
      <ServiceMap topology={latest.topology} provenance={provenanceOf(latest)} now={now} />
    </Framed>
  );
}
