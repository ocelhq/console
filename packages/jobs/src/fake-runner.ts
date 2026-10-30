import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Role } from "@console/connectors";
import {
  type JobRequest,
  JobSchema,
  JobState,
  type Job as RunnerJob,
} from "@console/connectors/gen/runner/v1/runner_pb";
import type { JobAt, RunnerCalls } from "./runner";

export interface Started {
  job: JobAt;
  request: JobRequest;
  token: string;
}

export interface FakeRunner extends RunnerCalls {
  started: Started[];
  canceled: string[];
  canceledAs: Map<string, Role>;
  jobs: Map<string, RunnerJob>;
  refuse: { start?: ConnectError; get?: ConnectError };
  set(jobId: string, state: JobState, error?: string): void;
}

export function fakeRunner(): FakeRunner {
  const jobs = new Map<string, RunnerJob>();
  const runner: FakeRunner = {
    started: [],
    canceled: [],
    canceledAs: new Map(),
    jobs,
    refuse: {},
    set(jobId, state, error) {
      const held = jobs.get(jobId) ?? create(JobSchema, { id: jobId });
      jobs.set(jobId, {
        ...held,
        state,
        ...(error
          ? { error: { $typeName: "runner.v1.JobError", code: "failed", message: error } }
          : {}),
      });
    },
    async start(job, request, token) {
      if (runner.refuse.start) throw runner.refuse.start;
      runner.started.push({ job, request, token });
      const held = jobs.get(job.jobId);
      if (held) return held;
      const made = create(JobSchema, { id: job.jobId, state: JobState.QUEUED });
      jobs.set(job.jobId, made);
      return made;
    },
    async get(job) {
      if (runner.refuse.get) throw runner.refuse.get;
      const held = jobs.get(job.jobId);
      if (!held) throw new ConnectError("no such job", Code.NotFound);
      return held;
    },
    async cancel(job, role) {
      runner.canceled.push(job.jobId);
      runner.canceledAs.set(job.jobId, role);
      const held = jobs.get(job.jobId);
      if (!held) throw new ConnectError("no such job", Code.NotFound);
      runner.set(job.jobId, JobState.CANCELED);
      return jobs.get(job.jobId);
    },
  };
  return runner;
}
