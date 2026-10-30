import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { EndpointReach, type EndpointSchema } from "@console/connectors/gen/console/v1/endpoint_pb";
import type { ResolvedEndpoint } from "@console/endpoints";
import { computeKindOf } from "../deployments/compute";

export type EndpointMessage = MessageInitShape<typeof EndpointSchema>;

export function endpointMessage(endpoint: ResolvedEndpoint): EndpointMessage {
  const denied = endpoint.lastDenied;
  return {
    id: endpoint.id,
    organizationId: endpoint.organizationId,
    name: endpoint.name,
    target: endpoint.target ?? "",
    vendor: endpoint.vendor,
    compute: computeKindOf(endpoint.compute),
    reach: EndpointReach.DIAL,
    url: endpoint.url ?? undefined,
    publicKey: endpoint.publicKey ?? undefined,
    tlsPin: endpoint.tlsPin ?? undefined,
    version: endpoint.version ?? undefined,
    services: [...endpoint.services],
    allowedScopes: [...endpoint.allowedScopes],
    connectedAt: endpoint.connectedAt ? timestampFromDate(endpoint.connectedAt) : undefined,
    lastSeenAt: endpoint.lastSeenAt ? timestampFromDate(endpoint.lastSeenAt) : undefined,
    lastDenied: denied
      ? { verb: denied.verb, at: timestampFromDate(new Date(denied.at)), message: denied.message }
      : undefined,
    online: endpoint.online,
  };
}
