import { createServer, type Server } from "node:http";
import {
  create,
  type DescMethod,
  isMessage,
  type Message,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import { timestampFromDate, timestampNow } from "@bufbuild/protobuf/wkt";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  type Job,
  JobCommand,
  type JobEvent,
  JobEventLevel,
  JobEventSchema,
  type JobInput,
  JobPhase,
  JobSchema,
  JobService,
  JobState,
  type RespondJobRequest,
  RespondJobRequestSchema,
} from "@console/connectors/gen/cloud/v1/job_pb";
import { SetValueRequestSchema } from "@console/connectors/gen/provider/variablestore/v1/variablestore_pb";
import { decodeJwt, type JWTPayload } from "jose";

// The fake answers each JobService call as Ocel Cloud's controlplane does, without a
// builder: a job not yet ended stands for one that runs, and nothing runs it on. It reads
// a token's claims as trust.Verifier does but never checks the signature.

export interface Seen {
  method: string;
  authorization: string;
  jobId: string;
  afterSeq?: bigint;
  limit?: number;
  inputId?: string;
  answer?: RespondJobRequest["answer"];
}

interface Stored {
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

const trustedConsole = "http://localhost:3000";
const audience = "ocel-cloud";
const skewSeconds = 30;
const defaultEventsLimit = 200;

const scopes = new Map<DescMethod, string>([
  [JobService.method.startJob, "cloud.apps.write"],
  [JobService.method.cancelJob, "cloud.apps.write"],
  [JobService.method.getJob, "cloud.apps.read"],
  [JobService.method.listJobEvents, "cloud.apps.read"],
]);

const validator = createValidator();

function scopeFor(method: DescMethod, request: Message): string | undefined {
  if (isMessage(request, RespondJobRequestSchema)) {
    return request.answer.case === "variables" ? "cloud.variables.write" : "cloud.apps.write";
  }
  return scopes.get(method);
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

function untrusted(reason: string): ConnectError {
  return new ConnectError(
    `the token speaks for no caller Ocel Cloud trusts: ${reason}`,
    Code.Unauthenticated,
  );
}

function claimsOf(authorization: string): JWTPayload {
  const raw = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!raw) {
    throw untrusted("no bearer token");
  }
  try {
    return decodeJwt(raw);
  } catch {
    throw untrusted("the bearer token is not a jwt");
  }
}

function organizationOf(needed: string | undefined, authorization: string): string {
  const claims = claimsOf(authorization);
  const now = Date.now() / 1000;
  if (claims.iss?.replace(/\/+$/, "") !== trustedConsole) {
    throw untrusted(`issuer "${claims.iss ?? ""}" is no console Ocel Cloud trusts`);
  }
  if (![claims.aud].flat().includes(audience)) {
    throw untrusted(`"aud" not satisfied`);
  }
  if (claims.exp !== undefined && claims.exp < now - skewSeconds) {
    throw untrusted(`"exp" not satisfied`);
  }
  if ((claims.nbf ?? 0) > now + skewSeconds || (claims.iat ?? 0) > now + skewSeconds) {
    throw untrusted(`"iat" or "nbf" not satisfied`);
  }
  const organization = claims.sub?.startsWith("org:") ? claims.sub.slice("org:".length) : "";
  if (!organization) {
    throw untrusted(`the token speaks for "${claims.sub ?? ""}", not an organization`);
  }
  if (!("scope" in claims)) {
    throw untrusted("the token has no scope");
  }
  const { scope } = claims;
  if (!Array.isArray(scope) || !scope.every((name) => typeof name === "string")) {
    throw untrusted("the token's scope is not a list of names");
  }
  if (!needed || !scope.includes(needed)) {
    throw new ConnectError(`the token has no ${needed ?? ""} scope`, Code.PermissionDenied);
  }
  return organization;
}

function ended(state: JobState): boolean {
  return [JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELED].includes(state);
}

function cellName(folder: string, key: string): string {
  return folder === "" ? key : `${folder}/${key}`;
}

// answered checks answer answers input as answerFor and the variable store do, and is the
// job's log line for it, as describeAnswer writes it.
function answered(input: JobInput, answer: RespondJobRequest["answer"]): string {
  switch (input.need.case) {
    case "variables": {
      if (answer.case !== "variables") {
        throw new ConnectError(
          `input ${input.id} asks for values, not a confirmation`,
          Code.InvalidArgument,
        );
      }
      const wanted = new Set(input.need.value.variables.map((v) => cellName(v.folder, v.key)));
      const given = answer.value.values.map((value) => cellName(value.folder, value.key));
      const twice = given.find((name, i) => given.indexOf(name) !== i);
      if (twice) {
        throw new ConnectError(`${twice} is given twice`, Code.InvalidArgument);
      }
      const extra = given.filter((name) => !wanted.has(name));
      if (extra.length > 0) {
        throw new ConnectError(
          `input ${input.id} asks for no ${extra.join(", ")}: give values only for the variables it needs`,
          Code.InvalidArgument,
        );
      }
      for (const [i, { folder, key, value }] of answer.value.values.entries()) {
        const set = create(SetValueRequestSchema, {
          tier: input.need.value.tier,
          // The fake keeps no job's slug; any valid one stands in for it.
          coordinate: { slug: "web", folder, key },
          value,
        });
        const result = validator.validate(SetValueRequestSchema, set);
        if (result.kind !== "valid") {
          throw new ConnectError(
            `${given[i]} can't be stored: ${result.error.message}`,
            Code.InvalidArgument,
          );
        }
      }
      return `Values given for ${given.join(", ")}`;
    }
    case "confirmation":
      if (answer.case !== "confirmed") {
        throw new ConnectError(
          `input ${input.id} asks a question, not for values`,
          Code.InvalidArgument,
        );
      }
      return `Answered ${answer.value ? "yes" : "no"}: ${input.need.value.question}`;
  }
  throw new ConnectError(
    `input ${input.id} asks for nothing this Ocel Cloud knows how to answer`,
    Code.FailedPrecondition,
  );
}

export async function startFakeCloud(): Promise<FakeCloud> {
  const stored = new Map<string, Stored>();
  const seen: Seen[] = [];
  let failure: ConnectError | null = null;

  // receive takes a call as the controlplane's interceptors do: the request is validated
  // before the token is read. It answers the organization the token speaks for.
  function receive(
    context: HandlerContext,
    request: Message,
    said: Omit<Seen, "method" | "authorization">,
  ) {
    const authorization = context.requestHeader.get("authorization") ?? "";
    seen.push({ method: context.method.name, authorization, ...said });
    if (failure) {
      throw failure;
    }
    const result = validator.validate(context.method.input, request);
    if (result.kind !== "valid") {
      throw new ConnectError(result.error.message, Code.InvalidArgument);
    }
    return organizationOf(scopeFor(context.method, request), authorization);
  }

  function owned(
    context: HandlerContext,
    request: Message & { jobId: string },
    said: Omit<Seen, "method" | "authorization" | "jobId"> = {},
  ): Stored {
    const organization = receive(context, request, { jobId: request.jobId, ...said });
    const found = stored.get(`${organization}/${request.jobId}`);
    if (!found) {
      throw new ConnectError(`your organization has no job ${request.jobId}`, Code.NotFound);
    }
    return found;
  }

  function log(found: Stored, level: JobEventLevel, message: string) {
    found.events.push(
      create(JobEventSchema, {
        seq: BigInt(found.events.length + 1),
        time: timestampNow(),
        level,
        phase: found.job.phase,
        message,
      }),
    );
  }

  const server: Server = createServer(
    connectNodeAdapter({
      routes(router) {
        router.service(JobService, {
          async startJob(request, context) {
            receive(context, request, { jobId: "" });
            throw new ConnectError(
              "this Ocel Cloud runs no builder, so it starts no jobs",
              Code.FailedPrecondition,
            );
          },
          async getJob(request, context) {
            return { job: owned(context, request).job };
          },
          async cancelJob(request, context) {
            const found = owned(context, request);
            const { job } = found;
            if (!ended(job.state)) {
              job.state = JobState.CANCELED;
              job.step = "Canceled";
              job.input = undefined;
              job.error = undefined;
              job.endedAt = timestampNow();
              log(found, JobEventLevel.WARN, "The job was canceled");
            }
            return { job };
          },
          async listJobEvents(request, context) {
            const found = owned(context, request, {
              afterSeq: request.afterSeq,
              limit: request.limit,
            });
            const after = found.events.filter((event) => event.seq > request.afterSeq);
            const limit = request.limit || defaultEventsLimit;
            return {
              events: after.slice(0, limit),
              more: after.length > limit,
              job: found.job,
            };
          },
          async respondJob(request, context) {
            const found = owned(context, request, {
              inputId: request.inputId,
              answer: request.answer,
            });
            const { job } = found;
            if (job.state !== JobState.INPUT_REQUIRED) {
              throw new ConnectError(
                `job ${job.id} waits on no input: it is ${JobState[job.state].toLowerCase()}`,
                Code.FailedPrecondition,
              );
            }
            if (!job.input) {
              throw new ConnectError(
                `job ${job.id} waits on no input now`,
                Code.FailedPrecondition,
              );
            }
            if (job.input.id !== request.inputId) {
              throw new ConnectError(
                `job ${job.id} waits on input ${job.input.id}, not ${request.inputId}: read the job again and answer what it asks now`,
                Code.FailedPrecondition,
              );
            }
            const line = answered(job.input, request.answer);
            job.state = JobState.RUNNING;
            job.input = undefined;
            job.step = "Resuming with the answer";
            log(found, JobEventLevel.INFO, line);
            return { job };
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
      stored.set(`${organizationId}/${created.id}`, {
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
