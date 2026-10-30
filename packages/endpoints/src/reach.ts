import type { DescMethod } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type Clients,
  clientsOf,
  type Endpoint,
  type Refusal,
  type Scope,
  scopeForCall,
} from "@console/connectors";
import { db } from "@console/db";
import { endpoint as endpointTable } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import type { Member } from "./member";
import type { ResolvedEndpoint } from "./resolve";
import { signEndpointToken } from "./token";

const TOKEN_LIFETIME_SECONDS = 60;

export interface Reach {
  endpoint: ResolvedEndpoint;
  at: Endpoint;
  clients: Clients;
  scopeFor(call: DescMethod): Scope | undefined;
  serves(call: DescMethod): boolean;
}

export function reachOf(member: Member, endpoint: ResolvedEndpoint): Reach | null {
  if (endpoint.url === null) return null;
  const scopeFor = (call: DescMethod) => scopeForCall(member.role, endpoint.allowedScopes, call);
  const at: Endpoint = {
    url: endpoint.url,
    controlUrl: endpoint.controlUrl ?? endpoint.url,
    async authorize(call) {
      const scope = scopeFor(call);
      if (scope === undefined) {
        throw new ConnectError(
          `Neither your role nor endpoint ${endpoint.name} allows ${call.parent.name}.${call.name}`,
          Code.PermissionDenied,
        );
      }
      return (await signEndpointToken(endpoint, member, [scope], TOKEN_LIFETIME_SECONDS)).token;
    },
  };
  return {
    endpoint,
    at,
    clients: clientsOf(at),
    scopeFor,
    serves: (call) =>
      endpoint.services.includes(call.parent.typeName) && scopeFor(call) !== undefined,
  };
}

export async function recordDenied(
  endpoint: Pick<ResolvedEndpoint, "id" | "organizationId">,
  verb: string,
  refusal: Refusal,
): Promise<void> {
  if (refusal.reason !== "denied") return;
  await db
    .update(endpointTable)
    .set({ lastDenied: { verb, at: new Date().toISOString(), message: refusal.message } })
    .where(
      and(
        eq(endpointTable.id, endpoint.id),
        eq(endpointTable.organizationId, endpoint.organizationId),
      ),
    );
}
