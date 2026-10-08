import type { GitEvent, GitProvider, WebhookRequest } from "./provider";
import type { GitAppSummary, GitStore, OpenedApp } from "./store";

export interface GitEventContext {
  app: GitAppSummary;
  installation: { id: string; externalId: string; organizationId: string };
  projects: { id: string; organizationId: string }[];
}

export type GitEventHandler = (event: GitEvent, context: GitEventContext) => Promise<void>;

export interface WebhookDeps {
  store: GitStore;
  providerFor: (app: OpenedApp) => GitProvider;
  onEvent: GitEventHandler;
}

export function webhookHandler(deps: WebhookDeps) {
  return async (request: WebhookRequest, appId: string): Promise<Response> => {
    const app = await deps.store.loadApp(appId);
    if (!app) return Response.json({ error: "Not found" }, { status: 404 });

    const provider = deps.providerFor(app);
    if (!(await provider.verifyWebhook(request))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = provider.parseEvent(request);
    if (event) await dispatch(deps, app, event);
    return Response.json({ received: true }, { status: 202 });
  };
}

async function dispatch(deps: WebhookDeps, app: OpenedApp, event: GitEvent): Promise<void> {
  if (event.type === "uninstalled") {
    await deps.store.removeInstallation(app.id, event.installation);
    return;
  }

  if (event.type === "installed") {
    if (app.organizationId) {
      await deps.store.recordInstallation({
        gitAppId: app.id,
        organizationId: app.organizationId,
        externalId: event.installation,
        account: event.account,
      });
    }
    return;
  }

  const installation = await deps.store.findInstallation(app.id, event.installation);
  if (!installation) return;
  const projects = await deps.store.projectsForRepo(installation.id, event.repo.id);
  await deps.onEvent(event, {
    app,
    installation: {
      id: installation.id,
      externalId: installation.externalId,
      organizationId: installation.organizationId,
    },
    projects,
  });
}
