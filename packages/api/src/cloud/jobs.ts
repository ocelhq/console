import { create } from "@bufbuild/protobuf";
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
  VariableValuesSchema,
} from "@console/connectors/gen/cloud/v1/job_pb";
import { Scope } from "@console/connectors/gen/cloud/v1/scope_pb";
import type { CloudCaller } from "./caller";
import { readCloudOffer } from "./offer";
import { recordJobReport } from "./report";
import { signCloudToken } from "./token";
import { type CloudJob, type CloudJobEvent, cloudJobEventOf, cloudJobOf } from "./view";

export const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const JOB_EVENTS_LIMIT = 1000;

const tokenLifetime = 60;

const callTimeout = 10_000;

export type CloudRefusal = "not-found" | "ended" | "stale" | "invalid" | "refused" | "unreachable";

export const STALE_INPUT = "This request is no longer current. The job has moved on.";

export type CloudAnswer<T> =
  | { ok: true; result: T }
  | { ok: false; reason: CloudRefusal; message: string };

export interface JobEvents {
  job: CloudJob;
  events: CloudJobEvent[];
  more: boolean;
}

export interface VariableAnswer {
  key: string;
  folder: string;
  value: string;
}

export type JobAnswer =
  | { kind: "variables"; values: VariableAnswer[] }
  | { kind: "confirmation"; confirmed: boolean };

export interface CloudJobs {
  get(jobId: string): Promise<CloudAnswer<CloudJob>>;
  events(jobId: string, afterSeq: number, limit?: number): Promise<CloudAnswer<JobEvents>>;
  cancel(jobId: string): Promise<CloudAnswer<CloudJob>>;
  respond(jobId: string, inputId: string, answer: JobAnswer): Promise<CloudAnswer<CloudJob>>;
}

function refuse(reason: CloudRefusal, message: string): CloudAnswer<never> {
  return { ok: false, reason, message };
}

export function refusalOf(thrown: unknown): CloudAnswer<never> {
  if (!(thrown instanceof ConnectError)) {
    return refuse("unreachable", thrown instanceof Error ? thrown.message : String(thrown));
  }
  switch (thrown.code) {
    case Code.NotFound:
    case Code.PermissionDenied:
      return refuse("not-found", thrown.rawMessage);
    case Code.FailedPrecondition:
      return refuse("ended", thrown.rawMessage);
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

function answerOf(answer: JobAnswer): RespondJobRequest["answer"] {
  if (answer.kind === "confirmation") {
    return { case: "confirmed", value: answer.confirmed };
  }
  return {
    case: "variables",
    value: create(VariableValuesSchema, {
      values: answer.values.map(({ key, folder, value }) => ({ key, folder, value })),
    }),
  };
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
    scope: Scope,
    run: (client: Client<typeof JobService>) => Promise<CloudAnswer<T>>,
    refusal: (thrown: unknown) => CloudAnswer<never> = refusalOf,
  ): Promise<CloudAnswer<T>> => {
    try {
      const { token } = await signCloudToken(cloud, caller, [scope], tokenLifetime);
      const client = createClient(
        JobService,
        createConnectTransport({
          baseUrl: cloud.apiUrl,
          httpVersion: "1.1",
          interceptors: [bearing(token)],
          defaultTimeoutMs: callTimeout,
        }),
      );
      return await run(client);
    } catch (thrown) {
      return refusal(thrown);
    }
  };

  return {
    get: (jobId) =>
      call(Scope.APPS_READ, async (client) => jobOf((await client.getJob({ jobId })).job)),
    events: (jobId, afterSeq, limit = JOB_EVENTS_LIMIT) =>
      call(Scope.APPS_READ, async (client) => {
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
      call(Scope.APPS_WRITE, async (client) => jobOf((await client.cancelJob({ jobId })).job)),
    respond: (jobId, inputId, answer) =>
      call(
        Scope.APPS_WRITE,
        async (client) =>
          jobOf((await client.respondJob({ jobId, inputId, answer: answerOf(answer) })).job),
        respondRefusalOf,
      ),
  };
}
