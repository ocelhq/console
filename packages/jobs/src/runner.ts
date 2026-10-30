import { clientsOf, type Role } from "@console/connectors";
import type { JobRequest, Job as RunnerJob } from "@console/connectors/gen/runner/v1/runner_pb";
import { consoleMember, endpointOf, type Reach, reachOf } from "@console/endpoints";

export interface JobAt {
  jobId: string;
  organizationId: string;
  runnerId: string;
}

export interface RunnerCalls {
  start(job: JobAt, request: JobRequest, jobToken: string): Promise<RunnerJob | undefined>;
  get(job: JobAt): Promise<RunnerJob | undefined>;
  cancel(job: JobAt, role: Role): Promise<RunnerJob | undefined>;
}

async function reached(job: JobAt, role?: Role): Promise<Reach> {
  const endpoint = await endpointOf(job.organizationId, job.runnerId);
  const reach = endpoint && reachOf(consoleMember(job.organizationId, role), endpoint);
  if (!reach) throw new Error(`runner ${job.runnerId} has no address the console can reach`);
  return reach;
}

export const runnerCalls: RunnerCalls = {
  async start(job, request, jobToken) {
    const { at } = await reached(job);
    const client = clientsOf({ ...at, authorize: async () => jobToken }).runner;
    return (await client.startJob({ job: request })).job;
  },
  async get(job) {
    return (await (await reached(job)).clients.runner.getJob({ jobId: job.jobId })).job;
  },
  async cancel(job, role) {
    return (await (await reached(job, role)).clients.runner.cancelJob({ jobId: job.jobId })).job;
  },
};
