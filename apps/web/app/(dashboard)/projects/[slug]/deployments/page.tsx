import { db } from "@console/db";
import { project } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/access";
import { type DeploymentsQuery, DeploymentsView } from "./deployments-view";

export default async function DeploymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<DeploymentsQuery>;
}) {
  const [{ slug }, query, session] = await Promise.all([
    params,
    searchParams,
    requireOrganization(),
  ]);

  const [found] = await db
    .select({ id: project.id, name: project.name })
    .from(project)
    .where(and(eq(project.organizationId, session.activeOrganizationId), eq(project.slug, slug)));
  if (!found) {
    notFound();
  }

  return (
    <DeploymentsView
      base={`/projects/${slug}/deployments`}
      projects={{ [found.id]: { slug, name: found.name } }}
      query={query}
    />
  );
}
