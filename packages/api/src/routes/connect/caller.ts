import type { DescMethod } from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  createContextKey,
  type HandlerContext,
  type Interceptor,
} from "@connectrpc/connect";
import {
  type ActiveOrganizationSession,
  getActiveOrganizationSession,
  getSessionUserId,
} from "@console/auth";
import { GITHUB_ACTIONS_ISSUER } from "@console/git";
import { decodeJwt } from "jose";
import { isJobToken, type JobClaims, verifyJobToken } from "./job-token";

export type Caller =
  | { kind: "session"; session: ActiveOrganizationSession }
  | { kind: "pipeline-token"; token: string }
  | { kind: "job"; job: JobClaims };

const callerKey = createContextKey<Caller | null>(null);

function bearerOf(header: Headers): string | undefined {
  const [scheme, token] = (header.get("authorization") ?? "").split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

function fromGithubActions(token: string): boolean {
  try {
    return decodeJwt(token).iss === GITHUB_ACTIONS_ISSUER;
  } catch {
    return false;
  }
}

async function sessionCaller(header: Headers): Promise<Caller> {
  const session = await getActiveOrganizationSession(header);
  if (!session) {
    if (await getSessionUserId(header)) {
      throw new ConnectError(
        "The session has no active organization you belong to: create or join one in the console, then choose it",
        Code.FailedPrecondition,
      );
    }
    throw new ConnectError("A session is required", Code.Unauthenticated);
  }
  return { kind: "session", session };
}

async function callerFor(
  method: DescMethod,
  header: Headers,
  pipelines: ReadonlySet<DescMethod>,
  jobs: ReadonlySet<DescMethod>,
): Promise<Caller> {
  const bearer = bearerOf(header);
  if (bearer && pipelines.has(method) && fromGithubActions(bearer)) {
    return { kind: "pipeline-token", token: bearer };
  }
  if (bearer && jobs.has(method) && isJobToken(bearer)) {
    return { kind: "job", job: await verifyJobToken(bearer) };
  }
  return sessionCaller(header);
}

export function callerInterceptor(options: {
  open: readonly DescMethod[];
  pipelines: readonly DescMethod[];
  jobs: readonly DescMethod[];
}): Interceptor {
  const unauthenticated = new Set(options.open);
  const pipelines = new Set(options.pipelines);
  const jobs = new Set(options.jobs);
  return (next) => async (request) => {
    if (unauthenticated.has(request.method)) {
      return next(request);
    }
    const caller = await callerFor(request.method, request.header, pipelines, jobs);
    request.contextValues.set(callerKey, caller);
    return next(request);
  };
}

export function callerOf(context: HandlerContext): Caller {
  const caller = context.values.get(callerKey);
  if (caller === null) {
    throw new Error("a handler ran without callerInterceptor");
  }
  return caller;
}

export function sessionOf(context: HandlerContext): ActiveOrganizationSession {
  const caller = callerOf(context);
  if (caller.kind !== "session") {
    throw new Error("a handler that serves only sessions ran for a pipeline or a job");
  }
  return caller.session;
}
