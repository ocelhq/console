import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { refusedScope, scopeName } from "@console/connectors";
import type { ConsoleService } from "@console/connectors/gen/console/v1/console_pb";
import { endpointOf, readCloudOffer, signEndpointToken } from "@console/endpoints";
import { version } from "../../../../../apps/web/package.json";
import { memberOf } from "../../endpoints/member";

const endpointTokenLifetime = 5 * 60;

export const consoleService: ServiceImpl<typeof ConsoleService> = {
  async describe() {
    const cloud = readCloudOffer();
    return {
      consoleVersion: version,
      capabilities: ["deployments.report", "connectors", ...(cloud ? ["cloud"] : [])],
      cloud,
    };
  },

  async issueEndpointToken(request, context) {
    const reach = await memberOf(context.requestHeader, request.organizationId);
    if (reach.state === "signed-out") {
      throw new ConnectError("A session is required", Code.Unauthenticated);
    }
    if (reach.state === "not-member") {
      throw new ConnectError(
        `You are not a member of organization ${request.organizationId}`,
        Code.PermissionDenied,
      );
    }
    const { member } = reach;
    const endpoint = await endpointOf(member.organizationId, request.endpointId);
    if (!endpoint) {
      throw new ConnectError(
        `No endpoint ${request.endpointId} in organization ${member.organizationId}`,
        Code.NotFound,
      );
    }
    const refused = refusedScope(member.role, endpoint.allowedScopes, request.scopes);
    switch (refused?.because) {
      case "not-user":
        throw new ConnectError(
          `${scopeName(refused.scope)} is no scope a person can hold`,
          Code.InvalidArgument,
        );
      case "role":
        throw new ConnectError(
          `Your role in this organization does not allow ${scopeName(refused.scope)}`,
          Code.PermissionDenied,
        );
      case "endpoint":
        throw new ConnectError(
          `Endpoint ${endpoint.name} does not allow ${scopeName(refused.scope)}`,
          Code.PermissionDenied,
        );
    }
    const { token, expiresAt } = await signEndpointToken(
      endpoint,
      member,
      request.scopes,
      endpointTokenLifetime,
    );
    return { token, expiresAt: timestampFromDate(expiresAt) };
  },
};
