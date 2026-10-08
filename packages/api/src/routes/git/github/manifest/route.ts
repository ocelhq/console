import { consoleOrigin } from "@console/auth";
import {
  appName,
  type GitRuntime,
  githubManifest,
  manifestStartUrl,
  signState,
  stateSecret,
} from "@console/git";
import { z } from "zod";
import { readBody } from "../../../../body";
import { administerGit, GIT_REFUSAL_STATUS } from "../access";

const startSchema = z.object({
  owner: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/)
    .optional(),
});

const REFUSALS = {
  session: "Unauthorized",
  unconfigured: "Git integrations are not configured",
  forbidden: "Forbidden",
} as const;

export async function startManifest(
  request: Request,
  git: GitRuntime | undefined,
): Promise<Response> {
  const access = await administerGit(request, git);
  if (!access.ok) {
    return Response.json(
      { error: REFUSALS[access.refusal] },
      { status: GIT_REFUSAL_STATUS[access.refusal] },
    );
  }
  const { session } = access;

  const parsed = await readBody(request, startSchema);
  if (!parsed.ok) {
    return parsed.refusal;
  }

  const appRowId = crypto.randomUUID();
  const state = signState(
    "manifest",
    { organizationId: session.activeOrganizationId, userId: session.userId, appRowId },
    stateSecret(),
  );
  return Response.json({
    url: manifestStartUrl(parsed.data.owner, state),
    state,
    manifest: githubManifest({
      origin: consoleOrigin(),
      appRowId,
      name: appName(session.activeOrganizationId),
    }),
  });
}
