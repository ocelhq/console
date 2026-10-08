import { administers, consoleOrigin, getActiveOrganizationSession, roleOf } from "@console/auth";
import { githubManifest, gitRuntime, manifestStartUrl, signState, stateSecret } from "@console/git";
import { z } from "zod";
import { readBody } from "../../../../body";

const startSchema = z.object({
  owner: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/)
    .optional(),
});

export async function startManifest(request: Request): Promise<Response> {
  const session = await getActiveOrganizationSession(request.headers);
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!administers(await roleOf(session.userId, session.activeOrganizationId))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!gitRuntime()) {
    return Response.json({ error: "Git integrations are not configured" }, { status: 503 });
  }

  const parsed = await readBody(request, startSchema);
  if (!parsed.ok) {
    return parsed.refusal;
  }

  const appRowId = crypto.randomUUID();
  const state = signState(
    { organizationId: session.activeOrganizationId, userId: session.userId, appRowId },
    stateSecret(),
  );
  return Response.json({
    url: manifestStartUrl(parsed.data.owner, state),
    state,
    manifest: githubManifest({
      origin: consoleOrigin(),
      appRowId,
      name: `Ocel ${session.activeOrganizationId.slice(0, 8)}`,
    }),
  });
}
