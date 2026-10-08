import { type DeploymentStatus, deploymentStatus } from "@/lib/deployment-view";
import type { LatestDeployment } from "@/lib/deployments";
import { cn } from "@/lib/utils";
import { Stamp } from "../stamp";

export function StatusLine({
  deployment,
  now,
}: {
  deployment: LatestDeployment | undefined;
  now: string;
}) {
  if (!deployment) {
    return (
      <span className="flex items-center gap-2 text-muted-foreground">
        <span aria-hidden className="size-1.5 shrink-0 border border-dim" />
        Not deployed yet
      </span>
    );
  }
  const status: DeploymentStatus = deployment.tornDownAt
    ? { word: "Destroyed", tone: "faint" }
    : deployment.outcome === "failed"
      ? { word: "Deploy failed", tone: "destructive" }
      : deploymentStatus(deployment);
  const at = deployment.tornDownAt ?? deployment.deployedAt;
  return (
    <span
      className={cn(
        "flex items-center gap-2",
        status.tone === "destructive" ? "text-destructive" : "text-foreground/80",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0",
          status.tone === "go" && "bg-go",
          status.tone === "faint" && "bg-dim",
          status.tone === "destructive" && "bg-destructive",
        )}
      />
      <Stamp at={at.toISOString()} now={now} prefix={status.word} />
    </span>
  );
}
