import { type Scope, scopeClaimed, USER_SCOPES } from "@console/connectors";
import { ProviderService } from "@console/connectors/gen/provider/contract/v1/contract_pb";
import { CostService } from "@console/connectors/gen/provider/cost/v1/cost_pb";
import { VariableStoreService } from "@console/connectors/gen/provider/variablestore/v1/variablestore_pb";
import { RunnerService } from "@console/connectors/gen/runner/v1/runner_pb";
import { db } from "@console/db";
import { type ComputeKind, type Endpoint, type EndpointDenial, endpoint } from "@console/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { liveness } from "./liveness";
import { type CloudOffer, OCEL_CLOUD_TARGET, readCloudOffer } from "./offer";

export const OCEL_CLOUD_ID = "ocel-cloud";

const CONTROL_SERVICES = [ProviderService, VariableStoreService, CostService].map(
  (service) => service.typeName,
);

export interface ResolvedEndpoint {
  id: string;
  organizationId: string;
  name: string;
  target: string | null;
  vendor: string;
  compute: ComputeKind | null;
  url: string | null;
  controlUrl: string | null;
  audience: string;
  publicKey: string | null;
  tlsPin: string | null;
  version: string | null;
  services: readonly string[];
  allowedScopes: readonly Scope[];
  connectedAt: Date | null;
  lastSeenAt: Date | null;
  lastDenied: EndpointDenial | null;
  online: boolean;
}

export function resolvedRow(row: Endpoint): ResolvedEndpoint {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    target: row.target,
    vendor: row.vendor,
    compute: row.compute,
    url: row.url,
    controlUrl: row.url,
    audience: row.id,
    publicKey: row.publicKey,
    tlsPin: row.tlsPin,
    version: row.version,
    services: row.services,
    allowedScopes: row.allowedScopes
      .map(scopeClaimed)
      .filter((scope): scope is Scope => scope !== undefined),
    connectedAt: row.connectedAt,
    lastSeenAt: row.lastSeenAt,
    lastDenied: row.lastDenied,
    online: liveness(row) === "online",
  };
}

function ocelCloud(offer: CloudOffer, organizationId: string): ResolvedEndpoint {
  const controlUrl = offer.providerUrl || null;
  return {
    id: OCEL_CLOUD_ID,
    organizationId,
    name: OCEL_CLOUD_ID,
    target: OCEL_CLOUD_TARGET,
    vendor: "ocel",
    compute: null,
    url: offer.apiUrl,
    controlUrl,
    audience: offer.audience,
    publicKey: null,
    tlsPin: null,
    version: offer.version || null,
    services: [RunnerService.typeName, ...(controlUrl ? CONTROL_SERVICES : [])],
    allowedScopes: USER_SCOPES,
    connectedAt: null,
    lastSeenAt: null,
    lastDenied: null,
    online: true,
  };
}

function offeredCloud(organizationId: string): ResolvedEndpoint | undefined {
  const offer = readCloudOffer();
  return offer && ocelCloud(offer, organizationId);
}

export function servesRunner(endpoint: Pick<ResolvedEndpoint, "services">): boolean {
  return endpoint.services.includes(RunnerService.typeName);
}

export async function endpointOf(
  organizationId: string,
  id: string,
): Promise<ResolvedEndpoint | undefined> {
  if (id === OCEL_CLOUD_ID) return offeredCloud(organizationId);
  const [found] = await db
    .select()
    .from(endpoint)
    .where(and(eq(endpoint.organizationId, organizationId), eq(endpoint.id, id)));
  return found && resolvedRow(found);
}

export async function endpointServing(
  organizationId: string,
  target: string,
): Promise<ResolvedEndpoint | undefined> {
  if (target === OCEL_CLOUD_TARGET) return offeredCloud(organizationId);
  const [found] = await db
    .select()
    .from(endpoint)
    .where(and(eq(endpoint.organizationId, organizationId), eq(endpoint.target, target)));
  return found && resolvedRow(found);
}

export async function endpointsOf(organizationId: string): Promise<ResolvedEndpoint[]> {
  const rows = await db
    .select()
    .from(endpoint)
    .where(eq(endpoint.organizationId, organizationId))
    .orderBy(asc(endpoint.name));
  return rows.map(resolvedRow);
}

export async function runnersOf(organizationId: string): Promise<ResolvedEndpoint[]> {
  const cloud = offeredCloud(organizationId);
  const rows = (await endpointsOf(organizationId)).filter(servesRunner);
  return cloud ? [cloud, ...rows] : rows;
}
