import { db } from "@console/db";
import { project, projectRepo } from "@console/db/schema";
import { endpointsOf, OCEL_CLOUD_ID, type ResolvedEndpoint, runnersOf } from "@console/endpoints";
import { pipelinesOf } from "@console/git";
import { type Bound, boundRunners, runnerIdOf } from "@console/jobs";
import { bindingsOf, issuancesOf, readIssuerSettings, targetsOf } from "@console/targets";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/access";
import { organizationOf } from "@/lib/organization";
import { targetLabel } from "@/lib/target-text";
import { issuanceView } from "@/lib/targets";
import { labelType } from "@/lib/type";
import { noticeBody, PageNotice, PageShell } from "../../../page-shell";
import { Issuances } from "../../../targets/issuances";
import { block } from "../git/shared";
import { Bindings } from "./bindings";
import { CredentialGrants } from "./grants";
import { type RunnerChoice, Runners } from "./runners";

function runnerChoices(
  serving: ResolvedEndpoint[],
  endpoints: ResolvedEndpoint[],
  bound: Bound[],
): RunnerChoice[] {
  const choices = serving.map((runner) => ({
    id: runner.id,
    label: runner.id === OCEL_CLOUD_ID ? "Ocel Cloud" : runner.name,
  }));
  const gone = [...new Set(bound.map((binding) => runnerIdOf(binding.runner)))]
    .filter((id) => !choices.some((choice) => choice.id === id))
    .map((id) => ({
      id,
      label:
        id === OCEL_CLOUD_ID
          ? "Ocel Cloud (no longer offered)"
          : `${endpoints.find((endpoint) => endpoint.id === id)?.name ?? id} (no longer serves a runner)`,
    }));
  return [...choices, ...gone];
}

export default async function ProjectTargetsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireOrganization();
  const organizationId = session.activeOrganizationId;
  const [found] = await db
    .select({ id: project.id, productionBranch: projectRepo.productionBranch })
    .from(project)
    .leftJoin(projectRepo, eq(projectRepo.projectId, project.id))
    .where(and(eq(project.organizationId, organizationId), eq(project.slug, slug)));
  if (!found) {
    notFound();
  }
  const organization = await organizationOf(session.userId, organizationId);
  if (!organization) {
    notFound();
  }

  if (!readIssuerSettings()) {
    return (
      <PageShell title="Targets">
        <PageNotice heading="The console issues no credentials">
          <p className={noticeBody}>
            Set an issuer key and restart the console, as the{" "}
            <Link href="/targets" className="underline underline-offset-4">
              Targets
            </Link>{" "}
            page says.
          </p>
        </PageNotice>
      </PageShell>
    );
  }

  const [targets, bindings, pipelines, issuances, serving, endpoints, runnerBindings] =
    await Promise.all([
      targetsOf(organizationId),
      bindingsOf(found.id),
      pipelinesOf(found.id),
      issuancesOf({ organizationId, projectId: found.id }),
      runnersOf(organizationId),
      endpointsOf(organizationId),
      boundRunners(found.id),
    ]);
  const runners = runnerChoices(serving, endpoints, runnerBindings);
  const now = new Date().toISOString();

  return (
    <PageShell
      title="Targets"
      description="Where this project’s tiers deploy, which runner runs their jobs, and which runs get short-lived credentials there."
    >
      <Bindings
        projectId={found.id}
        administers={organization.administers}
        targets={targets.map((target) => ({
          id: target.id,
          label: targetLabel(target),
          tiers: target.tiers.map((tier) => tier.tier),
        }))}
        bound={Object.fromEntries(bindings.map((binding) => [binding.tier, binding.targetId]))}
      />
      <Runners
        projectId={found.id}
        administers={organization.administers}
        runners={runners}
        bound={Object.fromEntries(
          runnerBindings.map((binding) => [
            binding.tier,
            { runnerId: runnerIdOf(binding.runner), credentials: binding.credentials },
          ]),
        )}
      />
      <CredentialGrants
        projectId={found.id}
        administers={organization.administers}
        productionBranch={found.productionBranch}
        pipelines={pipelines.map((pipeline) => ({
          id: pipeline.id,
          repository: pipeline.repository,
          workflow: pipeline.workflow,
          origin: pipeline.origin,
          production: pipeline.credentials.production
            ? {
                branches: pipeline.credentials.production.branches,
                environment: pipeline.credentials.production.environment ?? null,
              }
            : null,
          preview: pipeline.credentials.preview ?? null,
        }))}
      />
      <section className={block}>
        <h2 className={labelType}>Issued credentials</h2>
        <Issuances issuances={issuances.map(issuanceView)} now={now} showProject={false} />
      </section>
    </PageShell>
  );
}
