import { auth, roleOf } from "@console/auth";

export interface CloudCaller {
  userId: string;
  organizationId: string;
  role: string;
}

export type CloudReach =
  | { state: "signed-out" }
  | { state: "not-member" }
  | { state: "member"; caller: CloudCaller };

export async function cloudCallerOf(
  headers: Headers,
  organizationId: string | null,
): Promise<CloudReach> {
  const session = await auth.api.getSession({ headers });
  if (!session) {
    return { state: "signed-out" };
  }
  const chosen = organizationId ?? session.session.activeOrganizationId;
  const role = chosen ? await roleOf(session.user.id, chosen) : "";
  if (!chosen || role === "") {
    return { state: "not-member" };
  }
  return { state: "member", caller: { userId: session.user.id, organizationId: chosen, role } };
}
