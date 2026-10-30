import { memberOf } from "@console/api";
import {
  type ActiveOrganizationSession,
  getActiveOrganizationSession,
  getSessionUserId,
} from "@console/auth";
import { db } from "@console/db";
import { member, organization, user } from "@console/db/schema";
import type { Member } from "@console/endpoints";
import { asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { REQUEST_PATH_HEADER } from "./request-path";

export type Access =
  | { state: "signed-out" }
  | { state: "no-organization"; userId: string }
  | { state: "ready"; session: ActiveOrganizationSession };

export async function resolveAccess(requestHeaders: Headers): Promise<Access> {
  const session = await getActiveOrganizationSession(requestHeaders);
  if (session) {
    return { state: "ready", session };
  }

  const userId = await getSessionUserId(requestHeaders);
  return userId ? { state: "no-organization", userId } : { state: "signed-out" };
}

export const requireOrganization = cache(async (): Promise<ActiveOrganizationSession> => {
  const requestHeaders = await headers();
  const access = await resolveAccess(requestHeaders);
  const returnTo = encodeURIComponent(requestHeaders.get(REQUEST_PATH_HEADER) ?? "/");

  if (access.state === "signed-out") {
    redirect(`/sign-in?redirect=${returnTo}`);
  }
  if (access.state === "no-organization") {
    redirect(`/new?redirect=${returnTo}`);
  }
  return access.session;
});

export async function requireMember(organizationId: string): Promise<Member> {
  const requestHeaders = await headers();
  const reach = await memberOf(requestHeaders, organizationId);
  if (reach.state === "signed-out") {
    redirect(
      `/sign-in?redirect=${encodeURIComponent(requestHeaders.get(REQUEST_PATH_HEADER) ?? "/")}`,
    );
  }
  if (reach.state === "not-member") {
    notFound();
  }
  return reach.member;
}

export async function getViewer(userId: string) {
  const [viewer] = await db
    .select({ name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(eq(user.id, userId));
  return viewer ?? null;
}

export async function listMemberships(userId: string) {
  return db
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt));
}
