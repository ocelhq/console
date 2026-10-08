import { type GitEventHandler, gitRuntime, webhookHandler } from "@console/git";

const ignoreEvent: GitEventHandler = async () => {};

export async function githubWebhooks(
  request: Request,
  appId: string,
  onEvent: GitEventHandler = ignoreEvent,
): Promise<Response> {
  const runtime = gitRuntime();
  if (!runtime) {
    return Response.json({ error: "Git integrations are not configured" }, { status: 503 });
  }

  return webhookHandler({ ...runtime, onEvent })(
    { headers: request.headers, body: await request.text() },
    appId,
  );
}
