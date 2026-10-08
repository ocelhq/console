"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { TableBody, TableCell, TableRow } from "@/components/ui/table";
import {
  authorOf,
  commandOf,
  deploymentHref,
  deploymentStatus,
  duration,
  shortId,
} from "@/lib/deployment-view";
import type { DeploymentRow } from "@/lib/deployments";
import { Stamp } from "../../../stamp";
import { AppMarks, AuthorMark, EnvironmentBadge, StatusDot, Trigger } from "./cells";
import type { DeploymentProject } from "./columns";

const cell = "h-14 px-5 first:pl-5 last:pr-5";

function Row({
  deployment,
  project,
  withProject,
  now,
}: {
  deployment: DeploymentRow;
  project: DeploymentProject;
  withProject: boolean;
  now: string;
}) {
  const router = useRouter();
  const href = deploymentHref(project.slug, deployment.id);
  const status = deploymentStatus(deployment);
  const took = duration(deployment);
  const author = authorOf(deployment.trigger);

  return (
    <TableRow
      onClick={(event) => {
        if (event.defaultPrevented || (event.target as HTMLElement).closest("a, button")) {
          return;
        }
        router.push(href);
      }}
      className="group cursor-pointer has-[a:focus-visible]:bg-muted/50"
    >
      {withProject && (
        <TableCell className={`${cell} font-medium`}>
          <Link
            href={`/projects/${project.slug}/deployments`}
            className="underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            {project.name}
          </Link>
        </TableCell>
      )}
      <TableCell className={cell}>
        <span className="inline-flex items-baseline gap-2">
          <Link
            href={href}
            className="font-medium text-foreground underline-offset-4 outline-none group-hover:underline focus-visible:underline"
          >
            {shortId(deployment.promotionId) ?? "—"}
          </Link>
          {deployment.tag && <span className="text-muted-foreground">{deployment.tag}</span>}
        </span>
      </TableCell>
      <TableCell className={cell}>
        <span className="inline-flex items-baseline gap-2">
          <StatusDot tone={status.tone} />
          <span className={status.tone === "destructive" ? "text-destructive" : ""}>
            {status.word}
          </span>
          {took && (
            <span className="text-muted-foreground">
              in <span className="tabular-nums">{took}</span>
            </span>
          )}
        </span>
      </TableCell>
      <TableCell className={cell}>
        <EnvironmentBadge tier={deployment.tier} active={deployment.active} />
      </TableCell>
      <TableCell className={cell}>
        <AppMarks apps={deployment.apps} />
      </TableCell>
      <TableCell className={cell}>
        <Trigger trigger={deployment.trigger} command={commandOf(deployment)} />
      </TableCell>
      <TableCell className={`${cell} text-right text-muted-foreground`}>
        <span className="inline-flex items-center gap-2">
          <Stamp at={deployment.deployedAt.toISOString()} now={now} />
          {author && (
            <AuthorMark
              name={author}
              trigger={deployment.trigger}
              deployedAt={deployment.deployedAt.toISOString()}
            />
          )}
        </span>
      </TableCell>
    </TableRow>
  );
}

export function DeploymentRows({
  rows,
  projects,
  withProject,
  now,
}: {
  rows: DeploymentRow[];
  projects: Record<string, DeploymentProject>;
  withProject: boolean;
  now: string;
}) {
  return (
    <TableBody>
      {rows.map((deployment) => (
        <Row
          key={deployment.id}
          deployment={deployment}
          project={projects[deployment.projectId]}
          withProject={withProject}
          now={now}
        />
      ))}
    </TableBody>
  );
}
