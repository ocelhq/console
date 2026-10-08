import { type GitEventHandler, type GitRuntime, webhookHandler } from "@console/git";

const ignoreEvent: GitEventHandler = async () => {};

export async function githubWebhooks(
  request: Request,
  appRowId: string,
  git: GitRuntime | undefined,
  onEvent: GitEventHandler = ignoreEvent,
): Promise<Response> {
  if (!git) {
    return Response.json({ error: "Git integrations are not configured" }, { status: 503 });
  }

  return webhookHandler({ ...git, onEvent })(
    { headers: request.headers, body: await request.text() },
    appRowId,
  );
}
