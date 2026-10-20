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

const sessionKey = createContextKey<ActiveOrganizationSession | null>(null);

export function sessionInterceptor(open: readonly DescMethod[]): Interceptor {
  const unauthenticated = new Set(open);
  return (next) => async (request) => {
    if (unauthenticated.has(request.method)) {
      return next(request);
    }
    const session = await getActiveOrganizationSession(request.header);
    if (!session) {
      if (await getSessionUserId(request.header)) {
        throw new ConnectError(
          "The session has no active organization you belong to: create or join one in the console, then choose it",
          Code.FailedPrecondition,
        );
      }
      throw new ConnectError("A session is required", Code.Unauthenticated);
    }
    request.contextValues.set(sessionKey, session);
    return next(request);
  };
}

export function sessionOf(context: HandlerContext): ActiveOrganizationSession {
  const session = context.values.get(sessionKey);
  if (session === null) {
    throw new Error("a handler ran without sessionInterceptor");
  }
  return session;
}
