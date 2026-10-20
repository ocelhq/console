import type {
  CloudJob,
  CloudJobEvent,
  JobCommandName,
  JobPhaseName,
  JobStateName,
} from "@console/api";

export const JOB_POLL_MS = 1500;

const JOB_POLL_CEILING_MS = 15_000;

const terminal = new Set<JobStateName | null>(["succeeded", "failed", "canceled"]);

export function isTerminal(state: JobStateName | null): boolean {
  return terminal.has(state);
}

export function jobHref(id: string): string {
  return `/cloud/jobs/${id}`;
}

export type JobTone = "go" | "faint" | "destructive" | "warn";

export const stateWords: Record<JobStateName, { word: string; tone: JobTone; live: boolean }> = {
  queued: { word: "Queued", tone: "faint", live: true },
  running: { word: "Running", tone: "faint", live: true },
  "input-required": { word: "Needs your input", tone: "warn", live: false },
  succeeded: { word: "Succeeded", tone: "go", live: false },
  failed: { word: "Failed", tone: "destructive", live: false },
  canceled: { word: "Canceled", tone: "faint", live: false },
};

export function stateOf(state: JobStateName | null) {
  return state ? stateWords[state] : { word: "Unknown state", tone: "faint" as const, live: false };
}

const titles: Record<JobCommandName, string> = {
  build: "Build",
  deploy: "Deploy",
  "preview-up": "Preview",
};

export function titleOf(command: JobCommandName | null): string {
  return command ? titles[command] : "Job";
}

const commands: Record<JobCommandName, string> = {
  build: "ocel build",
  deploy: "ocel deploy",
  "preview-up": "ocel preview up",
};

export function commandOf(command: JobCommandName | null): string | null {
  return command ? commands[command] : null;
}

const phases: Record<JobPhaseName, string> = {
  check: "Check",
  build: "Build",
  plan: "Plan",
  provision: "Provision",
  deploy: "Deploy",
  promote: "Promote",
};

export function phaseWord(phase: JobPhaseName | null): string | null {
  return phase ? phases[phase] : null;
}

export function lastSeq(events: readonly CloudJobEvent[]): number {
  return events.at(-1)?.seq ?? 0;
}

export function appendEvents(
  shown: readonly CloudJobEvent[],
  incoming: readonly CloudJobEvent[],
): readonly CloudJobEvent[] {
  const after = lastSeq(shown);
  const fresh = incoming.filter((event) => event.seq > after);
  return fresh.length === 0 ? shown : [...shown, ...fresh];
}

export type LogLine =
  | { kind: "phase"; key: string; phase: JobPhaseName }
  | { kind: "event"; key: string; event: CloudJobEvent };

export function logLines(events: readonly CloudJobEvent[]): LogLine[] {
  const lines: LogLine[] = [];
  let phase: JobPhaseName | null = null;
  for (const event of events) {
    if (event.phase !== null && event.phase !== phase) {
      phase = event.phase;
      lines.push({ kind: "phase", key: `phase-${event.seq}`, phase });
    }
    lines.push({ kind: "event", key: `event-${event.seq}`, event });
  }
  return lines;
}

export function pollDelay(failures: number, more: boolean): number {
  if (more && failures === 0) {
    return 0;
  }
  return Math.min(JOB_POLL_MS * 2 ** failures, JOB_POLL_CEILING_MS);
}

export function shouldPoll(job: Pick<CloudJob, "state">, more: boolean): boolean {
  return more || !isTerminal(job.state);
}

export function clockOf(iso: string): string {
  return iso.slice(11, 19);
}
