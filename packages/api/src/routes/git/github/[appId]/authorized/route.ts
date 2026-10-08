import { type GitRuntime, stateSecret, verifyState } from "@console/git";
import { administerGit, authorizedUri, backToGitPage } from "../../access";

export async function githubAuthorized(
  request: Request,
  appRowId: string,
  git: GitRuntime | undefined,
): Promise<Response> {
  const access = await administerGit(request, git);
  if (!access.ok) return backToGitPage({ error: access.refusal });
  const { session, git: runtime } = access;

  const query = new URL(request.url).searchParams;
  if (query.get("error")) return backToGitPage({ error: "denied" });
  const code = query.get("code");
  const claims = verifyState("authorize", query.get("state") ?? "", stateSecret());
  if (
    !code ||
    !claims ||
    claims.userId !== session.userId ||
    claims.organizationId !== session.activeOrganizationId ||
    claims.appRowId !== appRowId
  ) {
    return backToGitPage({ error: "state" });
  }

  const app = await runtime.store.loadApp(appRowId);
  if (!app || (app.organizationId && app.organizationId !== claims.organizationId)) {
    return backToGitPage({ error: "app" });
  }

  let reachable: Awaited<ReturnType<ReturnType<GitRuntime["providerFor"]>["installationsOfUser"]>>;
  try {
    reachable = await runtime
      .providerFor(app)
      .installationsOfUser({ code, redirectUri: authorizedUri(app.id) });
  } catch (error) {
    console.error("git: GitHub refused to say which installations the person can reach", {
      appRowId,
      organizationId: claims.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return backToGitPage({ error: "github" });
  }

  const installation = reachable.find((candidate) => candidate.externalId === claims.installation);
  if (!installation) return backToGitPage({ error: "unreachable" });

  const bound = await runtime.store.bindInstallation({
    gitAppId: app.id,
    organizationId: claims.organizationId,
    externalId: installation.externalId,
    account: installation.account,
  });
  if (bound === "claimed") return backToGitPage({ error: "claimed" });
  return backToGitPage({ notice: "installed" });
}
