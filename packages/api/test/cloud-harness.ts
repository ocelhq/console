import { createServer, type Server } from "node:http";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  type Job,
  JobCommand,
  type JobEvent,
  JobEventLevel,
  JobEventSchema,
  JobPhase,
  JobSchema,
  JobService,
  JobState,
} from "@console/connectors/gen/cloud/v1/job_pb";
import { decodeJwt } from "jose";

export interface Seen {
  method: string;
  authorization: string;
  jobId: string;
  afterSeq?: bigint;
  limit?: number;
}

interface Stored {
  organizationId: string;
  job: Job;
  events: JobEvent[];
}

export interface FakeCloud {
  url: string;
  seen: Seen[];
  add(
    organizationId: string,
    job: MessageInitShape<typeof JobSchema>,
    events?: MessageInitShape<typeof JobEventSchema>[],
  ): void;
  failWith(error: ConnectError | null): void;
  close(): Promise<void>;
}

export function cloudJob(overrides: MessageInitShape<typeof JobSchema> = {}) {
  return {
    id: "job_1",
    projectId: "project-1",
    command: JobCommand.DEPLOY,
    state: JobState.RUNNING,
    phase: JobPhase.BUILD,
    step: "Building web",
    createdAt: timestampFromDate(new Date("2026-10-20T10:00:00.000Z")),
    startedAt: timestampFromDate(new Date("2026-10-20T10:00:02.000Z")),
    sourceId: "a".repeat(64),
    ...overrides,
  } satisfies MessageInitShape<typeof JobSchema>;
}

export function cloudEvent(seq: number, message: string, phase = JobPhase.BUILD) {
  return {
    seq: BigInt(seq),
    time: timestampFromDate(new Date(Date.UTC(2026, 9, 20, 10, 0, seq))),
    level: JobEventLevel.INFO,
    phase,
    message,
  } satisfies MessageInitShape<typeof JobEventSchema>;
}

export async function startFakeCloud(): Promise<FakeCloud> {
  const stored = new Map<string, Stored>();
  const seen: Seen[] = [];
  let failure: ConnectError | null = null;

  function owned(method: string, jobId: string, context: HandlerContext, extra = {}): Stored {
    const authorization = context.requestHeader.get("authorization") ?? "";
    seen.push({ method, authorization, jobId, ...extra });
    if (failure) {
      throw failure;
    }
    const token = authorization.replace(/^Bearer /, "");
    const sub = token ? String(decodeJwt(token).sub ?? "") : "";
    const found = stored.get(jobId);
    if (!found || sub !== `org:${found.organizationId}`) {
      throw new ConnectError(`no job ${jobId}`, Code.NotFound);
    }
    return found;
  }

  const server: Server = createServer(
    connectNodeAdapter({
      routes(router) {
        router.service(JobService, {
          async startJob() {
            throw new ConnectError("not in this fake", Code.Unimplemented);
          },
          async getJob(request, context) {
            return { job: owned("GetJob", request.jobId, context).job };
          },
          async cancelJob(request, context) {
            const found = owned("CancelJob", request.jobId, context);
            if (found.job.state >= JobState.SUCCEEDED) {
              throw new ConnectError("the job has ended", Code.FailedPrecondition);
            }
            found.job.state = JobState.CANCELED;
            return { job: found.job };
          },
          async listJobEvents(request, context) {
            const found = owned("ListJobEvents", request.jobId, context, {
              afterSeq: request.afterSeq,
              limit: request.limit,
            });
            const after = found.events.filter((event) => event.seq > request.afterSeq);
            const limit = request.limit || 100;
            return {
              events: after.slice(0, limit),
              more: after.length > limit,
              job: found.job,
            };
          },
        });
      },
    }),
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    add(organizationId, job, events = []) {
      const created = create(JobSchema, job);
      stored.set(created.id, {
        organizationId,
        job: created,
        events: events.map((event) => create(JobEventSchema, event)),
      });
    },
    failWith(error) {
      failure = error;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
