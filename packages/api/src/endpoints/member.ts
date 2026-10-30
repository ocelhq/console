import { auth, highestRole, roleOf } from "@console/auth";
import { Role } from "@console/connectors";
import type { Member } from "@console/endpoints";

export type MemberReach =
  | { state: "signed-out" }
  | { state: "not-member" }
  | { state: "member"; member: Member };

export async function memberOf(
  headers: Headers,
  organizationId: string | null,
): Promise<MemberReach> {
  const session = await auth.api.getSession({ headers });
  if (!session) {
    return { state: "signed-out" };
  }
  const chosen = organizationId ?? session.session.activeOrganizationId;
  const role = chosen ? highestRole(await roleOf(session.user.id, chosen)) : Role.UNSPECIFIED;
  if (!chosen || role === Role.UNSPECIFIED) {
    return { state: "not-member" };
  }
  return { state: "member", member: { userId: session.user.id, organizationId: chosen, role } };
}

export async function sessionMember(session: {
  userId: string;
  activeOrganizationId: string;
}): Promise<Member> {
  return {
    userId: session.userId,
    organizationId: session.activeOrganizationId,
    role: highestRole(await roleOf(session.userId, session.activeOrganizationId)),
  };
}
