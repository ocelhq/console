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
  link?: { href: string; label: string };
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

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

export function markdownText(value: string): string {
  return oneLine(value).replace(/[\\`*_[\]()#|<>~!&@]/g, "\\$&");
}

const longestRun = (value: string, mark: string) =>
  Math.max(0, ...(value.match(new RegExp(`${mark}+`, "g")) ?? []).map((run) => run.length));

export function markdownCode(value: string): string {
  const code = oneLine(value);
  const fence = "`".repeat(longestRun(code, "`") + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

export function markdownUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return url.href.replace(
    /[()[\]|<> "`]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function commit(repo: string, job: Job): string {
  const href = job.sha && markdownUrl(`https://github.com/${repo}/commit/${job.sha}`);
  if (!job.sha || !href) return "a commit";
  return `[${markdownCode(job.sha.slice(0, 7))}](${href})`;
}

const onBranch = (job: Job) => (job.branch ? ` on ${markdownCode(job.branch)}` : "");

function fenced(text: string): string[] {
  const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
  return [fence, text, fence];
}

function deployed(repo: string, job: Job, deployment: PreviewDeployment): string[] {
  const look = PROVIDERS[deployment.provider];
  const where = look?.home ?? markdownText(deployment.provider);
  const line = `Deployed ${commit(repo, job)} to ${where} · ${formatTime(deployment.finishedAt)}`;
  const headline = look
    ? `<img src="${LOGO_BASE}/${look.logo}.svg" alt="${look.name}" height="14"> ${line}`
    : line;
  return [
    headline,
    "",
    "| App | Preview | Status |",
    "| --- | --- | --- |",
    ...deployment.apps.map(({ name, url }) => {
      const href = url && markdownUrl(url);
      return href
        ? `| ${markdownText(name)} | [Visit preview ↗](${href}) | ✅ Ready |`
        : `| ${markdownText(name)} | no url | ❌ No URL |`;
    }),
  ];
}

function preview(repo: string, { job, deployment }: PreviewRow): string[] {
  switch (job.status) {
    case "queued":
      return [`⏳ Waiting for a runner to deploy ${commit(repo, job)}${onBranch(job)}.`];
    case "running":
      return [`🔄 Deploying ${commit(repo, job)}${onBranch(job)}…`];
    case "input-required":
      return [
        `⏸️ The deploy of ${commit(repo, job)}${onBranch(job)} waits for an answer on its deployment page.`,
      ];
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
        job.dispatchedAt || job.runUrl
          ? "💤 Removed: the preview is torn down."
          : "💤 Closed before a preview ran.",
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
    lines.push("", `#### ${markdownText(row.project)}`, "");
    lines.push(...(row.job.kind === "preview-rm" ? removal(row.job) : preview(repo, row)));
    const href = row.link && markdownUrl(row.link.href);
    if (row.link && href) lines.push("", `[${markdownText(row.link.label)}](${href})`);
  }
  return `${lines.join("\n")}\n`;
}
