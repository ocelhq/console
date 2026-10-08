import {
  Code,
  ConnectError,
  createContextKey,
  type HandlerContext,
  type Interceptor,
} from "@connectrpc/connect";
import { type ActiveOrganizationSession, getActiveOrganizationSession } from "@console/auth";

const sessionKey = createContextKey<ActiveOrganizationSession | null>(null);

export const sessionInterceptor: Interceptor = (next) => async (request) => {
  const session = await getActiveOrganizationSession(request.header);
  if (!session) {
    throw new ConnectError("A session is required", Code.Unauthenticated);
  }
  request.contextValues.set(sessionKey, session);
  return next(request);
};

export function sessionOf(context: HandlerContext): ActiveOrganizationSession {
  const session = context.values.get(sessionKey);
  if (session === null) {
    throw new Error("a handler ran without sessionInterceptor");
  }
  return session;
}
