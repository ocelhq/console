import type {
  Deployment,
  DeploymentKind,
  DeploymentOutcome,
  DeploymentTrigger,
  JobStatus,
} from "@console/db/schema";

export type Tone = "go" | "faint" | "destructive";

export type DeploymentStatus = { word: string; tone: Tone };

const kindWords: Record<DeploymentKind, string> = {
  deploy: "Deployed",
  "preview-up": "Deployed",
  rollback: "Rolled back",
};

export const NO_REPORT_AFTER_MS = 3 * 60 * 60 * 1000;

const endedRuns: Partial<Record<JobStatus, DeploymentOutcome>> = {
  failed: "failed",
  canceled: "canceled",
};

export function deploymentStatus(
  deployment: {
    kind: DeploymentKind;
    outcome: DeploymentOutcome | null;
    startedAt?: Date | null;
    createdAt?: Date;
    jobId?: string | null;
  },
  run: JobStatus | null = null,
  now: Date = new Date(),
): DeploymentStatus {
  switch (deployment.outcome ?? (run && endedRuns[run])) {
    case "failed":
      return { word: "Failed", tone: "destructive" };
    case "canceled":
      return { word: "Canceled", tone: "faint" };
    case "succeeded":
      return { word: kindWords[deployment.kind], tone: "go" };
  }
  if (run === "done") {
    return { word: "No report", tone: "faint" };
  }
  if (run === "input-required") {
    return { word: "Needs input", tone: "faint" };
  }
  const since = deployment.startedAt ?? deployment.createdAt;
  if (!deployment.jobId && since && now.getTime() - since.getTime() > NO_REPORT_AFTER_MS) {
    return { word: "No report", tone: "faint" };
  }
  return { word: deployment.startedAt || run === "running" ? "Running" : "Queued", tone: "faint" };
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
  if (!deployment.startedAt || !deployment.deployedAt) {
    return null;
  }
  return spanOf(deployment.startedAt.getTime(), deployment.deployedAt.getTime());
}

export function atOf(deployment: Pick<Deployment, "deployedAt" | "startedAt" | "createdAt">): Date {
  return deployment.deployedAt ?? deployment.startedAt ?? deployment.createdAt;
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

const runnerWords = (runner: string) =>
  runner === "ocel-cloud" ? "on Ocel Cloud's runner" : `on runner ${runner}`;

export function triggerLabel(trigger: DeploymentTrigger, command: string): string {
  const by = trigger.actor ? ` by ${trigger.actor}` : "";
  if (trigger.kind === "console")
    return `from the console${trigger.actor ? `, by ${trigger.actor}` : ""}`;
  if (trigger.remote) return `${command} --remote${by}, ${runnerWords(trigger.remote.runner)}`;
  return command;
}

const CI_NAMES: Record<string, string> = { "ocel-runner": "a runner" };

export function viaOf(trigger: DeploymentTrigger): string | null {
  if (trigger.kind !== "ci") return null;
  const provider = trigger.ci?.provider ?? "ci";
  return `via ${CI_NAMES[provider] ?? provider}`;
}

export const UNREPORTED_SUCCESS =
  "The runner says the job succeeded, but ocel's report never arrived, so the console has no record of what it deployed.";

export function unreportedNote(
  deployment: Pick<Deployment, "outcome" | "outcomeBy" | "jobId">,
): string | null {
  return deployment.outcome === "succeeded" &&
    deployment.outcomeBy === "console" &&
    deployment.jobId !== null
    ? UNREPORTED_SUCCESS
    : null;
}
