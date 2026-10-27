import { consoleOrigin } from "@console/auth";
import { db } from "@console/db";
import { project } from "@console/db/schema";
import { pipelinesOf } from "@console/git";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/access";
import { git } from "@/lib/git";
import { organizationOf } from "@/lib/organization";
import { noticeBody, PageNotice, PageShell } from "../../../page-shell";
import { DeploysIn } from "./deploys";
import { Pipelines } from "./pipelines";
import { Repository } from "./repository";

export default async function ProjectGitPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireOrganization();
  const [found] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.organizationId, session.activeOrganizationId), eq(project.slug, slug)));
  if (!found) {
    notFound();
  }
  const organization = await organizationOf(session.userId, session.activeOrganizationId);
  if (!organization) {
    notFound();
  }

  const runtime = git();
  if (!runtime) {
    return (
      <PageShell title="Git Integration">
        <PageNotice heading="Git integrations are off">
          <p className={noticeBody}>
            Set <span className="font-mono text-[13px]">CONSOLE_ENCRYPTION_KEY</span> and restart
            the console, then connect GitHub on the{" "}
            <Link href="/git" className="underline underline-offset-4">
              Git Integration
            </Link>{" "}
            page.
          </p>
        </PageNotice>
      </PageShell>
    );
  }

  const [linked, installations, pipelines] = await Promise.all([
    runtime.store.linkedRepo(found.id),
    runtime.store.installationsFor(session.activeOrganizationId),
    pipelinesOf(found.id),
  ]);
  const now = new Date().toISOString();

  return (
    <PageShell
      title="Git Integration"
      description="The repository this project deploys from, where its deploys run, and the CI pipelines it accepts deployment reports from."
    >
      <Repository
        projectId={found.id}
        administers={organization.administers}
        linked={
          linked && {
            fullName: linked.fullName,
            account: linked.account,
            productionBranch: linked.productionBranch,
          }
        }
        installations={installations.map(({ id, account }) => ({ id, account }))}
      />
      <DeploysIn
        projectId={found.id}
        administers={organization.administers}
        linked={linked ? { fullName: linked.fullName, deploys: linked.deploys } : null}
        audience={consoleOrigin()}
      />
      <Pipelines
        projectId={found.id}
        administers={organization.administers}
        deploysFromCi={linked?.deploys === "ci"}
        now={now}
        pipelines={pipelines.map((pipeline) => ({
          id: pipeline.id,
          repository: pipeline.repository,
          pending: pipeline.repositoryId === null,
          workflow: pipeline.workflow,
          environment: pipeline.environment,
          branches: pipeline.branches,
          origin: pipeline.origin,
          lastUsedAt: pipeline.lastUsedAt?.toISOString() ?? null,
        }))}
      />
    </PageShell>
  );
}
