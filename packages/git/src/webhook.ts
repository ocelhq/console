import { type GitEvent, MalformedWebhook, type WebhookRequest } from "./provider";
import type { GitRuntime } from "./runtime";
import type { StoredApp } from "./store";

export interface GitEventContext {
  deliveryId: string;
  app: StoredApp;
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

    await dispatch(deps, app, event, deliveryId);
    return Response.json({ received: true }, { status: 202 });
  };
}

async function dispatch(
  deps: WebhookDeps,
  app: StoredApp,
  event: GitEvent,
  deliveryId: string,
): Promise<void> {
  if (event.type === "uninstalled") {
    await deps.store.removeInstallation(app.id, event.installation);
    return;
  }
  await deps.onEvent(event, { deliveryId, app });
}
