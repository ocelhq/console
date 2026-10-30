import { Role } from "@console/connectors";

export interface Member {
  userId: string;
  organizationId: string;
  role: Role;
}

const CONSOLE_ACTOR = "console";

export function consoleMember(organizationId: string, role: Role = Role.MEMBER): Member {
  return { userId: CONSOLE_ACTOR, organizationId, role };
}
