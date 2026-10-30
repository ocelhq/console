import { type Stored, variables } from "@console/connectors";
import { db } from "@console/db";
import { project } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/access";
import { barred, endpointFor } from "@/lib/connectors";
import { latestTopology, namedEnvironments } from "@/lib/project-variables";
import { tierOf } from "@/lib/tier";
import { stateOf } from "@/lib/variables";
import { PageShell } from "../../../page-shell";
import { Provenance } from "./provenance";
import { LoadError, NeverDeployed, NoConnector, Refused } from "./states";
import { VariablesTable } from "./table";

export default async function VariablesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ env?: string }>;
}) {
  const { slug } = await params;
  const { env } = await searchParams;
  const tier = tierOf(env);

  const session = await requireOrganization();
  const [found] = await db
    .select({ id: project.id, slug: project.slug })
    .from(project)
    .where(and(eq(project.organizationId, session.activeOrganizationId), eq(project.slug, slug)));
  if (!found) {
    notFound();
  }

  const latest = await latestTopology(found.id, tier);
  if (latest.error) {
    return (
      <PageShell title="Variables">
        <LoadError />
      </PageShell>
    );
  }
  if (latest.row === null) {
    return (
      <PageShell title="Variables">
        <NeverDeployed />
      </PageShell>
    );
  }

  const environments = await namedEnvironments(found.id);
  const reach = await endpointFor(session, latest.row.target);

  let stored: readonly Stored[] = [];
  let refusal = null;
  if (reach !== null) {
    const answer = await variables.list(reach.endpoint, tier, found.slug);
    if (answer.done) {
      stored = answer.result;
    } else {
      refusal = answer.refusal;
    }
  }

  const readOnly = reach === null || refusal !== null;
  const state = stateOf(
    found.slug,
    tier,
    latest.row.topology,
    stored,
    environments,
    reach?.ability ?? barred,
    readOnly ? "unknown" : "live",
  );
  const now = new Date().toISOString();

  return (
    <PageShell title="Variables">
      <Provenance
        deployedAt={latest.row.deployedAt.toISOString()}
        now={now}
        promotion={latest.row.promotionId}
        provider={latest.row.providerName}
        region={latest.row.providerRegion}
        live={reach !== null && refusal === null}
      />
      {reach === null && <NoConnector vendor={latest.row.providerName} />}
      {refusal !== null && (
        <Refused
          reason={refusal.reason}
          message={refusal.message}
          provider={latest.row.providerName}
        />
      )}
      <VariablesTable projectId={found.id} environment={tier} initial={state} readOnly={readOnly} />
    </PageShell>
  );
}
