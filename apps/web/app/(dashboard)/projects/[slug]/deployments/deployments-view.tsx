import Link from "next/link";
import { Button } from "@/components/ui/button";
import { listDeployments } from "@/lib/deployments";
import { tierScopeOf } from "@/lib/tier";
import { PageShell } from "../../../page-shell";
import type { DeploymentProject } from "./columns";
import { DeploymentFilter } from "./filter";
import { Frame, LoadError, NeverDeployed, NothingOlder } from "./states";
import { DeploymentRows } from "./table";

export type DeploymentsQuery = { [key: string]: string | string[] | undefined };

export async function DeploymentsView({
  base,
  projects,
  query,
}: {
  base: string;
  projects: Record<string, DeploymentProject>;
  query: DeploymentsQuery;
}) {
  const scope = tierScopeOf(typeof query.env === "string" ? query.env : null);
  const beforeMs = typeof query.before === "string" ? Number(query.before) : Number.NaN;
  const before = Number.isFinite(beforeMs) ? new Date(beforeMs) : null;
  const withProject = base === "/deployments";

  const href = (older?: number) => {
    const params = new URLSearchParams();
    if (scope !== "all") {
      params.set("env", scope);
    }
    if (older) {
      params.set("before", String(older));
    }
    const search = params.toString();
    return `${base}${search ? `?${search}` : ""}`;
  };

  const load = await listDeployments(Object.keys(projects), scope === "all" ? null : scope, before);
  const now = new Date().toISOString();

  return (
    <PageShell title="Deployments">
      <div className="flex flex-col gap-3">
        <DeploymentFilter />
        <Frame withProject={withProject}>
          {load.error ? (
            <LoadError href={href(before?.getTime())} withProject={withProject} />
          ) : load.rows.length === 0 ? (
            before ? (
              <NothingOlder href={href()} withProject={withProject} />
            ) : (
              <NeverDeployed scope={scope} withProject={withProject} />
            )
          ) : (
            <DeploymentRows
              rows={load.rows}
              projects={projects}
              withProject={withProject}
              now={now}
            />
          )}
        </Frame>
        {!load.error && (before || load.more) && (
          <div className="flex items-center gap-2">
            {before && (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link href={href()} />}
              >
                Newest
              </Button>
            )}
            {load.more && (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link href={href(load.rows[load.rows.length - 1].deployedAt.getTime())} />}
              >
                Older
              </Button>
            )}
          </div>
        )}
      </div>
    </PageShell>
  );
}
