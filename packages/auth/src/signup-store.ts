import { db } from "@console/db";
import { invitation, user } from "@console/db/schema";
import { and, eq, gt, sql } from "drizzle-orm";
import type { SignupStore } from "./signup";

export const databaseSignupStore: SignupStore = {
  async hasUsers() {
    const [row] = await db.select({ id: user.id }).from(user).limit(1);
    return row !== undefined;
  },
  async hasPendingInvitation(email) {
    const [row] = await db
      .select({ id: invitation.id })
      .from(invitation)
      .where(
        and(
          eq(sql`lower(${invitation.email})`, email.toLowerCase()),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row !== undefined;
  },
};
