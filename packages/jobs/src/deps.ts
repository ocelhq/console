import type { Notify } from "./changes";
import type { RunnerCalls } from "./runner";

export type GitToken = (projectId: string) => Promise<string>;

export interface JobDeps {
  runners: RunnerCalls;
  notify: Notify;
  gitToken?: GitToken;
  now?: () => Date;
}

export const nowOf = (deps: Pick<JobDeps, "now">): Date => deps.now?.() ?? new Date();
