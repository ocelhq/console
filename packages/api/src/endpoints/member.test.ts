import { auth } from "@console/auth";
import { Role } from "@console/connectors";
import { setupTestDatabase } from "@console/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createTestSessionWithOrganization,
  createTestSessionWithRole,
} from "../../test/auth-harness";
import { memberOf } from "./member";

describe("memberOf", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("answers the active organization and the caller's role in it when no organization is named", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      expect(await memberOf(session.headers, null)).toEqual({
        state: "member",
        member: {
          userId: session.user.id,
          organizationId: session.organization.id,
          role: Role.OWNER,
        },
      });
    } finally {
      await session.cleanup();
    }
  });

  it("answers the named organization, not the active one, for a member of both", async () => {
    const named = await createTestSessionWithOrganization();
    const active = await createTestSessionWithOrganization();
    const joined = await createTestSessionWithRole(active.organization.id, "admin");
    try {
      await auth.api.addMember({
        body: { userId: joined.user.id, organizationId: named.organization.id, role: "member" },
      });

      expect(await memberOf(joined.headers, named.organization.id)).toEqual({
        state: "member",
        member: {
          userId: joined.user.id,
          organizationId: named.organization.id,
          role: Role.MEMBER,
        },
      });
    } finally {
      await joined.cleanup();
      await named.cleanup();
      await active.cleanup();
    }
  });

  it("refuses an organization the caller does not belong to, never falling back to the active one", async () => {
    const mine = await createTestSessionWithOrganization();
    const theirs = await createTestSessionWithOrganization();
    try {
      expect(await memberOf(mine.headers, theirs.organization.id)).toEqual({
        state: "not-member",
      });
    } finally {
      await mine.cleanup();
      await theirs.cleanup();
    }
  });

  it("answers signed-out with no session", async () => {
    expect(await memberOf(new Headers(), "org-1")).toEqual({ state: "signed-out" });
  });
});
