import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { administers, roleOf } from "@console/auth";
import {
  ConnectorReach,
  type ConnectorService,
} from "@console/connectors/gen/console/v1/connector_pb";
import { db } from "@console/db";
import { type Connector, connector } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { liveness } from "../connectors/liveness";
import { computeKindOf, computeKinds } from "./compute";
import { sessionOf } from "./session";

function connectorMessage(row: Connector) {
  const denied = row.lastDenied;
  return {
    id: row.id,
    organizationId: row.organizationId,
    target: row.target,
    vendor: row.vendor,
    compute: computeKindOf(row.compute),
    reach: ConnectorReach.DIAL,
    url: row.url ?? undefined,
    publicKey: row.publicKey ?? undefined,
    tlsPin: row.tlsPin ?? undefined,
    version: row.version ?? undefined,
    capabilities: row.capabilities,
    connectedAt: row.connectedAt ? timestampFromDate(row.connectedAt) : undefined,
    lastSeenAt: row.lastSeenAt ? timestampFromDate(row.lastSeenAt) : undefined,
    lastDenied: denied
      ? { verb: denied.verb, at: timestampFromDate(new Date(denied.at)), message: denied.message }
      : undefined,
    online: liveness(row) === "online",
  };
}

async function requireAdministeringSession(context: HandlerContext) {
  const session = sessionOf(context);
  if (!administers(await roleOf(session.userId, session.activeOrganizationId))) {
    throw new ConnectError(
      "Only an owner or an admin may change a connector",
      Code.PermissionDenied,
    );
  }
  return session;
}

async function ownedConnectorId(organizationId: string, id: string): Promise<string> {
  const [found] = await db
    .select({ id: connector.id })
    .from(connector)
    .where(and(eq(connector.id, id), eq(connector.organizationId, organizationId)));
  if (!found) {
    throw new ConnectError(`No connector ${id} in the session's organization`, Code.NotFound);
  }
  return found.id;
}

function requireWritten<T>(row: T | undefined): T {
  if (!row) {
    throw new ConnectError("the write returned no connector", Code.Internal);
  }
  return row;
}

export const connectorService: ServiceImpl<typeof ConnectorService> = {
  async upsert(request, context) {
    const session = await requireAdministeringSession(context);
    const [saved] = await db
      .insert(connector)
      .values({
        id: uuidv7(),
        organizationId: session.activeOrganizationId,
        target: request.target,
        vendor: request.vendor,
        reach: "dial",
      })
      .onConflictDoUpdate({
        target: [connector.organizationId, connector.target],
        set: { vendor: request.vendor, reach: "dial" },
      })
      .returning();
    return { connector: connectorMessage(requireWritten(saved)) };
  },

  async list(_request, context) {
    const rows = await db
      .select()
      .from(connector)
      .where(eq(connector.organizationId, sessionOf(context).activeOrganizationId))
      .orderBy(connector.createdAt);
    return { connectors: rows.map(connectorMessage) };
  },

  async setAddress(request, context) {
    const session = await requireAdministeringSession(context);
    const id = await ownedConnectorId(session.activeOrganizationId, request.id);
    const [saved] = await db
      .update(connector)
      .set({
        url: request.url,
        ...(request.publicKey !== undefined && { publicKey: request.publicKey }),
        ...(request.tlsPin !== undefined && { tlsPin: request.tlsPin }),
        ...(computeKinds[request.compute] !== undefined && {
          compute: computeKinds[request.compute],
        }),
      })
      .where(eq(connector.id, id))
      .returning();
    return { connector: connectorMessage(requireWritten(saved)) };
  },

  async remove(request, context) {
    const session = await requireAdministeringSession(context);
    const id = await ownedConnectorId(session.activeOrganizationId, request.id);
    await db.delete(connector).where(eq(connector.id, id));
    return {};
  },
};
