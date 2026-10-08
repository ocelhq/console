import { type GitEvent, MalformedWebhook, type WebhookRequest } from "./provider";
import type { GitRuntime } from "./runtime";
import type { StoredApp } from "./store";

export interface GitEventContext {
  app: StoredApp;
  installation: { id: string; externalId: string; organizationId: string };
  projects: { id: string; organizationId: string }[];
}

export type GitEventHandler = (event: GitEvent, context: GitEventContext) => Promise<void>;

export interface WebhookDeps extends GitRuntime {
  onEvent: GitEventHandler;
}

const refuse = (error: string, status: number) => Response.json({ error }, { status });

export function webhookHandler(deps: WebhookDeps) {
  return async (request: WebhookRequest, appRowId: string): Promise<Response> => {
    const app = await deps.store.loadApp(appRowId);
    if (!app) return refuse("Not found", 404);

    const provider = deps.providerFor(app);
    if (!(await provider.verifyWebhook(request))) return refuse("Unauthorized", 401);

    const deliveryId = provider.deliveryId(request);
    if (!deliveryId) return refuse("The delivery has no id", 400);

    let event: GitEvent | undefined;
    try {
      event = provider.parseEvent(request);
    } catch (error) {
      if (error instanceof MalformedWebhook) return refuse(error.message, 400);
      throw error;
    }
    if (!event) return Response.json({ received: true }, { status: 202 });

    if (!(await deps.store.recordDelivery(app.id, deliveryId))) {
      return Response.json({ received: true, duplicate: true }, { status: 202 });
    }
    try {
      await dispatch(deps, app, event);
    } catch (error) {
      await deps.store.forgetDelivery(app.id, deliveryId);
      throw error;
    }
    return Response.json({ received: true }, { status: 202 });
  };
}

async function dispatch(deps: WebhookDeps, app: StoredApp, event: GitEvent): Promise<void> {
  if (event.type === "uninstalled") {
    await deps.store.removeInstallation(app.id, event.installation);
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
