import type { Job } from "@console/db/schema";

export const PREVIEW_MARKER = "<!-- ocel-preview -->";

export interface PreviewApp {
  name: string;
  url?: string;
}

export interface PreviewDeployment {
  provider: string;
  finishedAt: Date;
  apps: PreviewApp[];
}

export interface PreviewRow {
  project: string;
  job: Job;
  deployment?: PreviewDeployment;
}

const LOGO_BASE = "https://raw.githubusercontent.com/ocelhq/ocel/main/www/public/providers";

const PROVIDERS: Record<string, { name: string; logo: string; home: string }> = {
  aws: { name: "AWS", logo: "aws", home: "your AWS account" },
  vps: { name: "VPS", logo: "vps", home: "your own server" },
};

function formatTime(date: Date): string {
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${text} UTC`;
}

function commit(repo: string, job: Job): string {
  if (!job.sha) return "a commit";
  return `[\`${job.sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${job.sha})`;
}

const onBranch = (job: Job) => (job.branch ? ` on \`${job.branch}\`` : "");

function fenced(text: string): string[] {
  const fence = text.includes("```") ? "~~~~" : "```";
  return [fence, text, fence];
}

function deployed(repo: string, job: Job, deployment: PreviewDeployment): string[] {
  const look = PROVIDERS[deployment.provider];
  const where = look?.home ?? deployment.provider;
  const line = `Deployed ${commit(repo, job)} to ${where} · ${formatTime(deployment.finishedAt)}`;
  const headline = look
    ? `<img src="${LOGO_BASE}/${look.logo}.svg" alt="${look.name}" height="14"> ${line}`
    : line;
  return [
    headline,
    "",
    "| App | Preview | Status |",
    "| --- | --- | --- |",
    ...deployment.apps.map(({ name, url }) =>
      url
        ? `| ${name} | [Visit preview ↗](${url}) | ✅ Ready |`
        : `| ${name} | no url | ❌ No URL |`,
    ),
  ];
}

function preview(repo: string, { job, deployment }: PreviewRow): string[] {
  switch (job.status) {
    case "queued":
      return [`⏳ Waiting for a runner to deploy ${commit(repo, job)}${onBranch(job)}.`];
    case "claimed":
    case "running":
      return [`🔄 Deploying ${commit(repo, job)}${onBranch(job)}…`];
    case "done":
      return deployment
        ? deployed(repo, job, deployment)
        : [`✅ Ready: ${commit(repo, job)}${onBranch(job)}.`];
    case "failed":
      return [
        `❌ Preview failed for ${commit(repo, job)}${onBranch(job)}.`,
        ...(job.error ? ["", ...fenced(job.error)] : []),
      ];
    case "canceled":
      return [`⏭️ Superseded: ${commit(repo, job)}${onBranch(job)}.`];
  }
}

function removal(job: Job): string[] {
  switch (job.status) {
    case "done":
      return [
        job.claimedAt ? "💤 Removed: the preview is torn down." : "💤 Closed before a preview ran.",
      ];
    case "failed":
      return ["❌ Removal failed.", ...(job.error ? ["", ...fenced(job.error)] : [])];
    default:
      return ["🔄 Removing the preview…"];
  }
}

export function renderPreviewComment(repo: string, rows: PreviewRow[]): string {
  const lines = [PREVIEW_MARKER, "", "### Ocel preview"];
  for (const row of rows) {
    lines.push("", `#### ${row.project}`, "");
    lines.push(...(row.job.kind === "preview-rm" ? removal(row.job) : preview(repo, row)));
    if (row.job.runUrl) lines.push("", `[Run log](${row.job.runUrl})`);
  }
  return `${lines.join("\n")}\n`;
}
