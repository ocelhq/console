import type { Job } from "@console/db/schema";

export const PREVIEW_MARKER = "<!-- ocel-preview -->";

export interface PreviewRow {
  project: string;
  job: Job;
  url?: string;
}

function describe(job: Job): string {
  if (job.kind === "preview-rm") {
    if (job.status === "done") return job.claimedAt ? "Removed" : "Closed";
    return job.status === "failed" ? "Removal failed" : "Removing";
  }
  switch (job.status) {
    case "queued":
      return "Waiting for a runner";
    case "claimed":
    case "running":
      return "Deploying";
    case "done":
      return "Ready";
    case "failed":
      return "Failed";
    case "canceled":
      return "Superseded";
  }
}

export function renderPreviewComment(rows: PreviewRow[]): string {
  const lines = rows.map(({ project, job, url }) => {
    const commit = job.sha ? `\`${job.sha.slice(0, 7)}\`` : "";
    const link = url && job.kind === "preview-up" && job.status === "done" ? url : "";
    return `| ${project} | ${commit} | ${describe(job)} | ${link} |`;
  });
  return [
    PREVIEW_MARKER,
    "### Ocel preview",
    "",
    "| Project | Commit | Status | Preview |",
    "| --- | --- | --- | --- |",
    ...lines,
  ].join("\n");
}
