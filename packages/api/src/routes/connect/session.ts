import { Code, ConnectError, createContextKey, type Interceptor } from "@connectrpc/connect";
import { getActiveOrganizationSession } from "@console/auth";

export const organizationKey = createContextKey<string | undefined>(undefined);

export const sessionInterceptor: Interceptor = (next) => async (request) => {
  const session = await getActiveOrganizationSession(request.header);
  if (!session) {
    throw new ConnectError("A session is required", Code.Unauthenticated);
  }
  request.contextValues.set(organizationKey, session.activeOrganizationId);
  return next(request);
};
