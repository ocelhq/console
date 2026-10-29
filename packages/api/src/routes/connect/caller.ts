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

export type Caller =
  | { kind: "session"; session: ActiveOrganizationSession }
  | { kind: "pipeline-token"; token: string }
  | { kind: "anonymous" };

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

export function callerInterceptor(options: {
  open: readonly DescMethod[];
  optionalSession: readonly DescMethod[];
  pipelines: readonly DescMethod[];
}): Interceptor {
  const unauthenticated = new Set(options.open);
  const optionalSession = new Set(options.optionalSession);
  const pipelines = new Set(options.pipelines);
  return (next) => async (request) => {
    if (unauthenticated.has(request.method)) {
      return next(request);
    }
    if (optionalSession.has(request.method)) {
      const session = await getActiveOrganizationSession(request.header);
      request.contextValues.set(
        callerKey,
        session ? { kind: "session", session } : { kind: "anonymous" },
      );
      return next(request);
    }
    const bearer = bearerOf(request.header);
    const caller: Caller =
      pipelines.has(request.method) && bearer && fromGithubActions(bearer)
        ? { kind: "pipeline-token", token: bearer }
        : await sessionCaller(request.header);
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

export function authenticatedCallerOf(
  context: HandlerContext,
): Exclude<Caller, { kind: "anonymous" }> {
  const caller = callerOf(context);
  if (caller.kind === "anonymous") {
    throw new Error("a handler that serves only authenticated callers ran for an anonymous one");
  }
  return caller;
}

export function optionalSessionCallerOf(
  context: HandlerContext,
): Exclude<Caller, { kind: "pipeline-token" }> {
  const caller = callerOf(context);
  if (caller.kind === "pipeline-token") {
    throw new Error(
      "a handler that serves sessions and anonymous callers ran for a pipeline token",
    );
  }
  return caller;
}

export function sessionOf(context: HandlerContext): ActiveOrganizationSession {
  const caller = callerOf(context);
  if (caller.kind !== "session") {
    throw new Error(`a handler that serves only sessions ran for a ${caller.kind} caller`);
  }
  return caller.session;
}
