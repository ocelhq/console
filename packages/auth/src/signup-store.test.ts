import { db } from "@console/db";
import { migrateDatabase } from "@console/db/migrate";
import { invitation, organization, user } from "@console/db/schema";
import { pg } from "@console/infra";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseSignupStore } from "./signup-store";

const suffix = crypto.randomUUID();
const inviterId = `inviter-${suffix}`;
const organizationId = `org-${suffix}`;
const hour = 60 * 60 * 1000;

function invited(email: string, status: string, expiresIn: number) {
  return {
    id: crypto.randomUUID(),
    organizationId,
    inviterId,
    email,
    status,
    expiresAt: new Date(Date.now() + expiresIn),
  };
}

beforeAll(async () => {
  await migrateDatabase(pg);
  await db
    .insert(user)
    .values({ id: inviterId, name: "Inviter", email: `${inviterId}@example.test` });
  await db
    .insert(organization)
    .values({ id: organizationId, name: "Org", slug: organizationId, createdAt: new Date() });
  await db
    .insert(invitation)
    .values([
      invited(`pending-${suffix}@example.test`, "pending", hour),
      invited(`expired-${suffix}@example.test`, "pending", -hour),
      invited(`accepted-${suffix}@example.test`, "accepted", hour),
    ]);
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, organizationId));
  await db.delete(user).where(eq(user.id, inviterId));
  await pg.end();
});

describe("databaseSignupStore", () => {
  it("sees a user once one exists", async () => {
    expect(await databaseSignupStore.hasUsers()).toBe(true);
  });

  it("finds a pending invitation whatever the email's case", async () => {
    expect(await databaseSignupStore.hasPendingInvitation(`PENDING-${suffix}@Example.test`)).toBe(
      true,
    );
  });

  it("ignores expired and accepted invitations", async () => {
    expect(await databaseSignupStore.hasPendingInvitation(`expired-${suffix}@example.test`)).toBe(
      false,
    );
    expect(await databaseSignupStore.hasPendingInvitation(`accepted-${suffix}@example.test`)).toBe(
      false,
    );
  });
});
