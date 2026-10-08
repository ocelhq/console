import {
  type ActiveOrganizationSession,
  administers,
  consoleOrigin,
  getActiveOrganizationSession,
  roleOf,
} from "@console/auth";
import type { GitRuntime } from "@console/git";

export type GitRefusal = "session" | "unconfigured" | "forbidden";

export type GitAccess =
  | { ok: true; session: ActiveOrganizationSession; git: GitRuntime }
  | { ok: false; refusal: GitRefusal };

export async function administerGit(
  request: Request,
  git: GitRuntime | undefined,
): Promise<GitAccess> {
  const session = await getActiveOrganizationSession(request.headers);
  if (!session) return { ok: false, refusal: "session" };
  if (!git) return { ok: false, refusal: "unconfigured" };
  if (!administers(await roleOf(session.userId, session.activeOrganizationId))) {
    return { ok: false, refusal: "forbidden" };
  }
  return { ok: true, session, git };
}

export const GIT_REFUSAL_STATUS: Record<GitRefusal, number> = {
  session: 401,
  unconfigured: 503,
  forbidden: 403,
};

export function backToGitPage(params: Record<string, string> = {}): Response {
  const url = new URL("/organization/git", consoleOrigin());
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return Response.redirect(url, 302);
}

export function authorizedUri(appRowId: string): string {
  return `${consoleOrigin()}/api/git/github/${encodeURIComponent(appRowId)}/authorized`;
}
