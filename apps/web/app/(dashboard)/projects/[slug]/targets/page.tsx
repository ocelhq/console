import { db } from "@console/db";
import { project, projectRepo } from "@console/db/schema";
import { pipelinesOf } from "@console/git";
import { bindingsOf, issuancesOf, readIssuerSettings, targetsOf } from "@console/targets";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/access";
import { organizationOf } from "@/lib/organization";
import { issuanceView } from "@/lib/targets";
import { labelType } from "@/lib/type";
import { noticeBody, PageNotice, PageShell } from "../../../page-shell";
import { Issuances } from "../../../targets/issuances";
import { block } from "../git/shared";
import { Bindings } from "./bindings";
import { CredentialGrants } from "./grants";

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

  const [targets, bindings, pipelines, issuances] = await Promise.all([
    targetsOf(organizationId),
    bindingsOf(found.id),
    pipelinesOf(found.id),
    issuancesOf({ organizationId, projectId: found.id }),
  ]);
  const now = new Date().toISOString();

  return (
    <PageShell
      title="Targets"
      description="Where this project’s tiers deploy, and which of its trusted pipelines’ runs get short-lived credentials there."
    >
      <Bindings
        projectId={found.id}
        administers={organization.administers}
        targets={targets.map((target) => ({
          id: target.id,
          label: `${target.vendor} ${target.account} ${target.region}`,
          tiers: target.tiers.map((tier) => tier.tier),
        }))}
        bound={Object.fromEntries(bindings.map((binding) => [binding.tier, binding.targetId]))}
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
