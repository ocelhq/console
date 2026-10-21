import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import type { ConsoleService } from "@console/connectors/gen/console/v1/console_pb";
import { version } from "../../../package.json";
import { CLOUD_SCOPES, type CloudScope, signCloudToken } from "../../cloud/token";
import { readCloudOffer } from "./cloud";
import { sessionOf } from "./session";

const cloudTokenLifetime = 5 * 60;

function cloudScopes(asked: readonly string[]): CloudScope[] {
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
  return [...asked] as CloudScope[];
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
    const { token, expiresAt } = await signCloudToken(
      cloud,
      { userId: session.userId, organizationId: session.activeOrganizationId },
      cloudScopes(request.scopes),
      cloudTokenLifetime,
    );
    return { token, expiresAt: timestampFromDate(expiresAt) };
  },
};
