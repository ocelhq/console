import { administers, consoleOrigin, getActiveOrganizationSession, roleOf } from "@console/auth";
import { convertManifest, gitRuntime, stateSecret, verifyState } from "@console/git";

function back(error?: string): Response {
  const url = new URL("/organization/git", consoleOrigin());
  if (error) url.searchParams.set("error", error);
  return Response.redirect(url, 302);
}

export async function manifestCallback(
  request: Request,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await getActiveOrganizationSession(request.headers);
  if (!session) return back("session");

  const runtime = gitRuntime();
  if (!runtime) return back("unconfigured");

  const query = new URL(request.url).searchParams;
  const code = query.get("code");
  const claims = verifyState(query.get("state") ?? "", stateSecret());
  if (
    !code ||
    !claims ||
    claims.userId !== session.userId ||
    claims.organizationId !== session.activeOrganizationId
  ) {
    return back("state");
  }
  if (!administers(await roleOf(session.userId, session.activeOrganizationId))) {
    return back("forbidden");
  }

  let credentials: Awaited<ReturnType<typeof convertManifest>>;
  try {
    credentials = await convertManifest(code, fetchImpl);
  } catch {
    return back("github");
  }

  try {
    await runtime.store.createOrganizationApp({
      id: claims.appRowId,
      organizationId: claims.organizationId,
      kind: "github",
      ...credentials,
    });
  } catch {
    return back("stored");
  }
  return Response.redirect(`https://github.com/apps/${credentials.slug}/installations/new`, 302);
}
