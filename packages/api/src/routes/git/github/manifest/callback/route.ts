import { convertManifest, type GitRuntime, stateSecret, verifyState } from "@console/git";
import { administerGit, backToGitPage } from "../../access";

const install = (slug: string) =>
  Response.redirect(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`, 302);

export async function manifestCallback(
  request: Request,
  git: GitRuntime | undefined,
): Promise<Response> {
  const access = await administerGit(request, git);
  if (!access.ok) return backToGitPage({ error: access.refusal });
  const { session, git: runtime } = access;

  const query = new URL(request.url).searchParams;
  const code = query.get("code");
  const claims = verifyState("manifest", query.get("state") ?? "", stateSecret());
  if (
    !code ||
    !claims ||
    claims.userId !== session.userId ||
    claims.organizationId !== session.activeOrganizationId
  ) {
    return backToGitPage({ error: "state" });
  }

  let credentials: Awaited<ReturnType<typeof convertManifest>>;
  try {
    credentials = await convertManifest(code, runtime.fetch);
  } catch (error) {
    console.error("git: GitHub refused the app manifest code", {
      appRowId: claims.appRowId,
      organizationId: claims.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return backToGitPage({ error: "github" });
  }

  const unsaved = (reason: string) => {
    console.error("git: the GitHub App GitHub created was not saved", {
      appRowId: claims.appRowId,
      organizationId: claims.organizationId,
      slug: credentials.slug,
      reason,
    });
    return backToGitPage({ error: "unsaved" });
  };

  try {
    const created = await runtime.store.createOrganizationApp({
      id: claims.appRowId,
      organizationId: claims.organizationId,
      kind: "github",
      ...credentials,
    });
    if (created) return install(created.slug);

    const stored = await runtime.store.loadApp(claims.appRowId);
    if (stored?.organizationId === claims.organizationId && stored.appId === credentials.appId) {
      return install(stored.slug);
    }
    return unsaved("another app is stored under that id or GitHub App id");
  } catch (error) {
    return unsaved(error instanceof Error ? error.message : String(error));
  }
}
