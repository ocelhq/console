import {
  Code,
  ConnectError,
  createContextKey,
  type HandlerContext,
  type Interceptor,
} from "@connectrpc/connect";
import { getActiveOrganizationSession } from "@console/auth";

const organizationKey = createContextKey<string | null>(null);

export const sessionInterceptor: Interceptor = (next) => async (request) => {
  const session = await getActiveOrganizationSession(request.header);
  if (!session) {
    throw new ConnectError("A session is required", Code.Unauthenticated);
  }
  request.contextValues.set(organizationKey, session.activeOrganizationId);
  return next(request);
};

export function organizationOf(context: HandlerContext): string {
  const organizationId = context.values.get(organizationKey);
  if (organizationId === null) {
    throw new Error("a handler ran without sessionInterceptor");
  }
  return organizationId;
}
