import type {
  Deployment,
  DeploymentKind,
  DeploymentOutcome,
  DeploymentTrigger,
} from "@console/db/schema";

export type Tone = "go" | "faint" | "destructive";

export type DeploymentStatus = { word: string; tone: Tone };

const kindWords: Record<DeploymentKind, string> = {
  deploy: "Deployed",
  "preview-up": "Deployed",
  rollback: "Rolled back",
};

export function deploymentStatus(deployment: {
  kind: DeploymentKind;
  outcome: DeploymentOutcome;
}): DeploymentStatus {
  if (deployment.outcome === "failed") {
    return { word: "Failed", tone: "destructive" };
  }
  return { word: kindWords[deployment.kind], tone: "go" };
}

export const kindVerbs: Record<DeploymentKind, string> = {
  deploy: "deploy",
  "preview-up": "preview",
  rollback: "rollback",
};

export function shortId(id: string | null): string | null {
  return id ? id.slice(0, 7) : null;
}

export function duration(deployment: Pick<Deployment, "startedAt" | "deployedAt">): string | null {
  if (!deployment.startedAt) {
    return null;
  }
  return spanOf(deployment.startedAt.getTime(), deployment.deployedAt.getTime());
}

export function spanOf(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function deploymentHref(slug: string, id: string): string {
  return `/projects/${slug}/deployments/${id}`;
}

export function commandOf(deployment: {
  kind: DeploymentKind;
  environmentIdentity: string;
  promotionId: string | null;
}): string {
  switch (deployment.kind) {
    case "deploy":
      return "ocel deploy";
    case "preview-up":
      return `ocel preview up ${deployment.environmentIdentity}`.trim();
    case "rollback":
      return `ocel rollback ${shortId(deployment.promotionId) ?? ""}`.trim();
  }
}

export function authorOf(trigger: DeploymentTrigger): string | null {
  return trigger.actor ?? null;
}
