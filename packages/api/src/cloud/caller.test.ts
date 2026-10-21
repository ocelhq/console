import { auth } from "@console/auth";
import { setupTestDatabase } from "@console/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createTestSessionWithOrganization,
  createTestSessionWithRole,
} from "../../test/auth-harness";
import { cloudCallerOf } from "./caller";

describe("cloudCallerOf", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("answers the active organization and the caller's role in it when no organization is named", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      expect(await cloudCallerOf(session.headers, null)).toEqual({
        state: "member",
        caller: { userId: session.user.id, organizationId: session.organization.id, role: "owner" },
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

      expect(await cloudCallerOf(joined.headers, named.organization.id)).toEqual({
        state: "member",
        caller: { userId: joined.user.id, organizationId: named.organization.id, role: "member" },
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
      expect(await cloudCallerOf(mine.headers, theirs.organization.id)).toEqual({
        state: "not-member",
      });
    } finally {
      await mine.cleanup();
      await theirs.cleanup();
    }
  });

  it("answers signed-out with no session", async () => {
    expect(await cloudCallerOf(new Headers(), "org-1")).toEqual({ state: "signed-out" });
  });
});
