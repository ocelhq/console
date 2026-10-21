import {
  type Client,
  Code,
  ConnectError,
  createClient,
  type Interceptor,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  type Job,
  JobService,
  type RespondJobRequest,
} from "@console/connectors/gen/cloud/v1/job_pb";
import { Scope } from "@console/connectors/gen/cloud/v1/scope_pb";
import type { CloudCaller } from "./caller";
import { readCloudOffer } from "./offer";
import { recordJobReport } from "./report";
import { lackedScope, signCloudToken } from "./token";
import { type CloudJob, type CloudJobEvent, cloudJobEventOf, cloudJobOf } from "./view";

export const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const JOB_EVENTS_LIMIT = 1000;

const tokenLifetime = 60;

const callTimeout = 10_000;

// Ocel Cloud waits up to 15 s for a canceled run to stop before it answers.
const cancelTimeout = 30_000;

export type CloudRefusal =
  | "not-found"
  | "forbidden"
  | "stale"
  | "invalid"
  | "refused"
  | "unreachable"
  | "internal";

export const STALE_INPUT = "This request is no longer current. The job has moved on.";

export const NOT_ALLOWED = "Your role in this organization does not allow this.";

export const CONSOLE_FAILED = "The console failed to ask Ocel Cloud. Its server logs say why.";

export type CloudAnswer<T> =
  | { ok: true; result: T }
  | { ok: false; reason: CloudRefusal; message: string };

export interface JobEvents {
  job: CloudJob;
  events: CloudJobEvent[];
  more: boolean;
}

export interface CloudJobs {
  events(jobId: string, afterSeq: number, limit?: number): Promise<CloudAnswer<JobEvents>>;
  cancel(jobId: string): Promise<CloudAnswer<CloudJob>>;
  respond(request: RespondJobRequest): Promise<CloudAnswer<CloudJob>>;
}

const scopesTo = {
  read: [Scope.APPS_READ],
  act: [Scope.APPS_READ, Scope.APPS_WRITE],
  giveValues: [Scope.APPS_READ, Scope.APPS_WRITE, Scope.VARIABLES_WRITE],
};

export function mayGiveValues(role: string): boolean {
  return lackedScope(role, scopesTo.giveValues) === undefined;
}

function refuse(reason: CloudRefusal, message: string): CloudAnswer<never> {
  return { ok: false, reason, message };
}

export function refusalOf(thrown: unknown): CloudAnswer<never> {
  if (!(thrown instanceof ConnectError)) {
    console.error("cloud: the console failed on a call to Ocel Cloud", thrown);
    return refuse("internal", CONSOLE_FAILED);
  }
  switch (thrown.code) {
    case Code.NotFound:
      return refuse("not-found", thrown.rawMessage);
    case Code.PermissionDenied:
      return refuse("forbidden", NOT_ALLOWED);
    case Code.Unauthenticated:
      return refuse("refused", `Ocel Cloud refused the console's token: ${thrown.rawMessage}`);
    default:
      return refuse("unreachable", thrown.rawMessage);
  }
}

export function respondRefusalOf(thrown: unknown): CloudAnswer<never> {
  if (thrown instanceof ConnectError) {
    switch (thrown.code) {
      case Code.FailedPrecondition:
        return refuse("stale", STALE_INPUT);
      case Code.InvalidArgument:
        return refuse("invalid", thrown.rawMessage);
    }
  }
  return refusalOf(thrown);
}

function jobOf(job: Job | undefined): CloudAnswer<CloudJob> {
  if (!job) {
    return refuse("unreachable", "Ocel Cloud answered without the job");
  }
  return { ok: true, result: cloudJobOf(job) };
}

function bearing(token: string): Interceptor {
  return (next) => (request) => {
    request.header.set("Authorization", `Bearer ${token}`);
    return next(request);
  };
}

export function cloudJobsFor(caller: CloudCaller): CloudJobs | null {
  const cloud = readCloudOffer();
  if (!cloud) {
    return null;
  }

  const call = async <T>(
    scopes: Scope[],
    run: (client: Client<typeof JobService>) => Promise<CloudAnswer<T>>,
    { refusal = refusalOf, timeoutMs = callTimeout } = {},
  ): Promise<CloudAnswer<T>> => {
    if (lackedScope(caller.role, scopes) !== undefined) {
      return refuse("forbidden", NOT_ALLOWED);
    }
    try {
      const { token } = await signCloudToken(cloud, caller, scopes, tokenLifetime);
      const client = createClient(
        JobService,
        createConnectTransport({
          baseUrl: cloud.apiUrl,
          httpVersion: "1.1",
          interceptors: [bearing(token)],
          defaultTimeoutMs: timeoutMs,
        }),
      );
      return await run(client);
    } catch (thrown) {
      return refusal(thrown);
    }
  };

  return {
    events: (jobId, afterSeq, limit = JOB_EVENTS_LIMIT) =>
      call(scopesTo.read, async (client) => {
        const answer = await client.listJobEvents({
          jobId,
          afterSeq: BigInt(afterSeq),
          limit: Math.min(limit, JOB_EVENTS_LIMIT),
        });
        const job = jobOf(answer.job);
        if (!job.ok) {
          return job;
        }
        if (answer.job && !answer.more) {
          await recordJobReport(caller.organizationId, answer.job);
        }
        return {
          ok: true,
          result: {
            job: job.result,
            events: answer.events.map(cloudJobEventOf),
            more: answer.more,
          },
        };
      }),
    cancel: (jobId) =>
      call(scopesTo.act, async (client) => jobOf((await client.cancelJob({ jobId })).job), {
        timeoutMs: cancelTimeout,
      }),
    respond: (request) =>
      call(
        request.answer.case === "variables" ? scopesTo.giveValues : scopesTo.act,
        async (client) => jobOf((await client.respondJob(request)).job),
        { refusal: respondRefusalOf },
      ),
  };
}
