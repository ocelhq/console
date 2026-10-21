import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import type { Scope } from "@console/connectors/gen/cloud/v1/scope_pb";
import type { ConsoleService } from "@console/connectors/gen/console/v1/console_pb";
import { version } from "../../../package.json";
import { cloudCallerOf } from "../../cloud/caller";
import { readCloudOffer } from "../../cloud/offer";
import { claimOf, lackedScope, scopeOf, signCloudToken } from "../../cloud/token";

const cloudTokenLifetime = 5 * 60;

function scopesAsked(asked: readonly string[]): Scope[] {
  return asked.map((named) => {
    const scope = scopeOf(named);
    if (scope === undefined) {
      throw new ConnectError(`"${named}" is no Ocel Cloud scope`, Code.InvalidArgument);
    }
    return scope;
  });
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
    const reach = await cloudCallerOf(context.requestHeader, request.organizationId);
    if (reach.state === "signed-out") {
      throw new ConnectError("A session is required", Code.Unauthenticated);
    }
    if (reach.state === "not-member") {
      throw new ConnectError(
        `You are not a member of organization ${request.organizationId}`,
        Code.PermissionDenied,
      );
    }
    const cloud = readCloudOffer();
    if (!cloud) {
      throw new ConnectError("This console offers no Ocel Cloud", Code.FailedPrecondition);
    }
    const scopes = scopesAsked(request.scopes);
    const lacked = lackedScope(reach.caller.role, scopes);
    if (lacked !== undefined) {
      throw new ConnectError(
        `Your role in this organization (${reach.caller.role}) does not allow ${claimOf(lacked)}`,
        Code.PermissionDenied,
      );
    }
    const { token, expiresAt } = await signCloudToken(
      cloud,
      reach.caller,
      scopes,
      cloudTokenLifetime,
    );
    return { token, expiresAt: timestampFromDate(expiresAt) };
  },
};
