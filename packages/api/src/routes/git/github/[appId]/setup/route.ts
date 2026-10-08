import { type GitRuntime, signState, stateSecret } from "@console/git";
import { administerGit, authorizedUri, backToGitPage } from "../../access";

const INSTALLATION_ID = /^\d{1,20}$/;

export async function githubSetup(
  request: Request,
  appRowId: string,
  git: GitRuntime | undefined,
): Promise<Response> {
  const access = await administerGit(request, git);
  if (!access.ok) return backToGitPage({ error: access.refusal });
  const { session, git: runtime } = access;

  const query = new URL(request.url).searchParams;
  if (query.get("setup_action") === "request") return backToGitPage({ notice: "requested" });
  const installation = query.get("installation_id") ?? "";
  if (!INSTALLATION_ID.test(installation)) return backToGitPage({ error: "installation" });

  const app = await runtime.store.loadApp(appRowId);
  if (!app || (app.organizationId && app.organizationId !== session.activeOrganizationId)) {
    return backToGitPage({ error: "app" });
  }

  const state = signState(
    "authorize",
    {
      organizationId: session.activeOrganizationId,
      userId: session.userId,
      appRowId: app.id,
      installation,
    },
    stateSecret(),
  );
  return Response.redirect(
    runtime.providerFor(app).authorizeUrl({ state, redirectUri: authorizedUri(app.id) }),
    302,
  );
}
