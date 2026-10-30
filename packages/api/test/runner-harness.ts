import { createServer, type Server } from "node:http";
import { create, type DescMethod, type Message, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate, timestampNow } from "@bufbuild/protobuf/wkt";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  claimOf,
  leastRoleOf,
  Role,
  reaches,
  requiredScope,
  roleClaimOf,
} from "@console/connectors";
import { SetValueRequestSchema } from "@console/connectors/gen/provider/variablestore/v1/variablestore_pb";
import {
  type Job,
  JobCommand,
  JobCommandSchema,
  type JobEvent,
  JobEventLevel,
  JobEventSchema,
  type JobInput,
  JobPhase,
  JobSchema,
  JobState,
  RunnerService,
  type VariableValue,
} from "@console/connectors/gen/runner/v1/runner_pb";
import { decodeJwt, type JWTPayload } from "jose";

export interface Seen {
  method: string;
  authorization: string;
  jobId: string;
  afterSeq?: bigint;
  limit?: number;
  inputId?: string;
  answer?: Answer;
}

type Answer =
  | { case: "confirmed"; value: boolean }
  | { case: "variables"; values: VariableValue[] };

interface Stored {
  job: Job;
  events: JobEvent[];
}

export interface FakeRunner {
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
export const RUNNER_AUDIENCE = "0b7f3c52-5d2a-4a8e-9a43-3c1f1d0e9a11";
const skewSeconds = 30;
const defaultEventsLimit = 200;

const validator = createValidator();

function scopeFor(method: DescMethod): string | undefined {
  const scope = requiredScope(method);
  return scope === undefined ? undefined : claimOf(scope);
}

export function runnerJob(overrides: MessageInitShape<typeof JobSchema> = {}) {
  return {
    id: "job_1",
    projectId: "project-1",
    command: JobCommand.DEPLOY,
    state: JobState.RUNNING,
    phase: JobPhase.BUILD,
    step: "Building web",
    createdAt: timestampFromDate(new Date("2026-10-20T10:00:00.000Z")),
    startedAt: timestampFromDate(new Date("2026-10-20T10:00:02.000Z")),
    ...overrides,
  } satisfies MessageInitShape<typeof JobSchema>;
}

export function runnerEvent(seq: number, message: string, phase = JobPhase.BUILD) {
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
    `the token speaks for no caller this runner trusts: ${reason}`,
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

const ROLES = new Map(
  [Role.MEMBER, Role.ADMIN, Role.OWNER].map((role) => [roleClaimOf(role), role]),
);

function roleOf(authorization: string): Role {
  const { role } = claimsOf(authorization);
  return (typeof role === "string" && ROLES.get(role)) || Role.UNSPECIFIED;
}

function refuseRoleBelowCommand(found: Stored, authorization: string) {
  const least = leastRoleOf(JobCommandSchema.value[found.job.command]);
  if (!reaches(roleOf(authorization), least)) {
    throw new ConnectError(
      `acting on this job needs the ${least === undefined ? "" : roleClaimOf(least)} role or above in the organization`,
      Code.PermissionDenied,
    );
  }
}

function organizationOf(needed: string | undefined, authorization: string): string {
  const claims = claimsOf(authorization);
  const now = Date.now() / 1000;
  if (claims.iss?.replace(/\/+$/, "") !== trustedConsole) {
    throw untrusted(`issuer "${claims.iss ?? ""}" is no console this runner trusts`);
  }
  if (![claims.aud].flat().includes(RUNNER_AUDIENCE)) {
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

function answered(input: JobInput, answer: Answer): string {
  switch (input.need.case) {
    case "variables": {
      if (answer.case !== "variables") {
        throw new ConnectError(
          `input ${input.id} asks for values, not a confirmation`,
          Code.InvalidArgument,
        );
      }
      const wanted = new Set(input.need.value.variables.map((v) => cellName(v.folder, v.key)));
      const given = answer.values.map((value) => cellName(value.folder, value.key));
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
      for (const [i, { folder, key, value }] of answer.values.entries()) {
        const set = create(SetValueRequestSchema, {
          tier: input.need.value.tier,
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
    `input ${input.id} asks for nothing this runner knows how to answer`,
    Code.FailedPrecondition,
  );
}

export async function startFakeRunner(): Promise<FakeRunner> {
  const stored = new Map<string, Stored>();
  const seen: Seen[] = [];
  let failure: ConnectError | null = null;

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
    return organizationOf(scopeFor(context.method), authorization);
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

  function actedOn(
    context: HandlerContext,
    request: Message & { jobId: string },
    said: Omit<Seen, "method" | "authorization" | "jobId"> = {},
  ): Stored {
    const found = owned(context, request, said);
    refuseRoleBelowCommand(found, context.requestHeader.get("authorization") ?? "");
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

  function respond(found: Stored, inputId: string, answer: Answer): Job {
    const { job } = found;
    if (job.state !== JobState.INPUT_REQUIRED || !job.input) {
      throw new ConnectError(`job ${job.id} waits on no input now`, Code.FailedPrecondition);
    }
    if (job.input.id !== inputId) {
      throw new ConnectError(
        `job ${job.id} waits on input ${job.input.id}, not ${inputId}`,
        Code.FailedPrecondition,
      );
    }
    const line = answered(job.input, answer);
    job.state = JobState.RUNNING;
    job.input = undefined;
    job.step = "Resuming with the answer";
    log(found, JobEventLevel.INFO, line);
    return job;
  }

  const server: Server = createServer(
    connectNodeAdapter({
      routes(router) {
        router.service(RunnerService, {
          async listMissingBlobs() {
            throw new ConnectError("the fake takes no uploads", Code.Unimplemented);
          },
          async commitSource() {
            throw new ConnectError("the fake takes no uploads", Code.Unimplemented);
          },
          async startJob(request, context) {
            receive(context, request, { jobId: "" });
            throw new ConnectError("the fake starts no jobs", Code.FailedPrecondition);
          },
          async getJob(request, context) {
            return { job: owned(context, request).job };
          },
          async cancelJob(request, context) {
            const found = actedOn(context, request);
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
          async answerConfirmation(request, context) {
            const answer: Answer = { case: "confirmed", value: request.confirmed };
            return {
              job: respond(
                actedOn(context, request, { inputId: request.inputId, answer }),
                request.inputId,
                answer,
              ),
            };
          },
          async supplyVariables(request, context) {
            const answer: Answer = { case: "variables", values: request.variables?.values ?? [] };
            return {
              job: respond(
                actedOn(context, request, { inputId: request.inputId, answer }),
                request.inputId,
                answer,
              ),
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
