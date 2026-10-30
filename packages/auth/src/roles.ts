import { Role, reaches } from "@console/connectors";

const roles: Record<string, Role> = {
  member: Role.MEMBER,
  admin: Role.ADMIN,
  owner: Role.OWNER,
};

export function highestRole(role: string): Role {
  return role
    .split(",")
    .map((named) => roles[named.trim()] ?? Role.UNSPECIFIED)
    .reduce((highest, held) => Math.max(highest, held), Role.UNSPECIFIED);
}

export function administers(role: string): boolean {
  return reaches(highestRole(role), Role.ADMIN);
}
