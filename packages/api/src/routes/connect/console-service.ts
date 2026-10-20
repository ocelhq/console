import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { signOrganizationToken } from "@console/auth";
import type { ConsoleService } from "@console/connectors/gen/console/v1/console_pb";
import { version } from "../../../package.json";
import { readCloudOffer } from "./cloud";
import { sessionOf } from "./session";

const CLOUD_SCOPES = ["cloud.apps.read", "cloud.apps.write"] as const;

const cloudTokenLifetime = 5 * 60;

function cloudScopes(asked: readonly string[]): string[] {
  if (asked.length === 0) {
    return [...CLOUD_SCOPES];
  }
  const known = new Set<string>(CLOUD_SCOPES);
  const unknown = asked.find((scope) => !known.has(scope));
  if (unknown !== undefined) {
    throw new ConnectError(
      `"${unknown}" is no Ocel Cloud scope; the scopes are ${CLOUD_SCOPES.join(", ")}`,
      Code.InvalidArgument,
    );
  }
  return [...asked];
}

export const consoleService: ServiceImpl<typeof ConsoleService> = {
  async describe() {
    const cloud = readCloudOffer();
    return {
      consoleVersion: version,
      capabilities: ["deployments.report", "connectors", ...(cloud ? ["cloud"] : [])],
      cloud,
    };
  },

  async issueCloudToken(request, context) {
    const session = sessionOf(context);
    const cloud = readCloudOffer();
    if (!cloud) {
      throw new ConnectError("This console offers no Ocel Cloud", Code.FailedPrecondition);
    }
    const { token, expiresAt } = await signOrganizationToken({
      audience: cloud.audience,
      organizationId: session.activeOrganizationId,
      userId: session.userId,
      scope: cloudScopes(request.scopes),
      lifetimeSeconds: cloudTokenLifetime,
    });
    return { token, expiresAt: timestampFromDate(expiresAt) };
  },
};
