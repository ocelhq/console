import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { administers, consoleOrigin, roleOf } from "@console/auth";
import { claimOf, Role, refusedScope, scopeName, USER_SCOPES } from "@console/connectors";
import type { EndpointService } from "@console/connectors/gen/console/v1/endpoint_pb";
import { db } from "@console/db";
import { type Endpoint, endpoint } from "@console/db/schema";
import { endpointsOf, resolvedRow } from "@console/endpoints";
import { and, eq, sql } from "drizzle-orm";
import { importJWK, jwtVerify } from "jose";
import { uuidv7 } from "uuidv7";
import { computeKinds } from "../../deployments/compute";
import { tierNamed } from "../../deployments/record";
import { endpointMessage } from "../../endpoints/message";
import { type Answer, bindRunner, resolveRunner, unbindRunner } from "../../endpoints/runners";
import { sessionOf } from "./caller";

function answered<T>(answer: Answer<T>): T {
  if (!answer.ok) throw new ConnectError(answer.message, answer.code);
  return answer.value;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ((error as { code?: string }).code === "23505") {
    return true;
  }
  return isUniqueViolation((error as { cause?: unknown }).cause);
}

async function requireAdministeringSession(context: HandlerContext) {
  const session = sessionOf(context);
  if (!administers(await roleOf(session.userId, session.activeOrganizationId))) {
    throw new ConnectError(
      "Only an owner or an admin may change an endpoint or a runner binding",
      Code.PermissionDenied,
    );
  }
  return session;
}

async function ownedEndpointId(organizationId: string, id: string): Promise<string> {
  const [found] = await db
    .select({ id: endpoint.id })
    .from(endpoint)
    .where(and(eq(endpoint.id, id), eq(endpoint.organizationId, organizationId)));
  if (!found) {
    throw new ConnectError(`No endpoint ${id} in the session's organization`, Code.NotFound);
  }
  return found.id;
}

function verifying(publicKey: string) {
  return importJWK(
    { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey, "base64").toString("base64url") },
    "EdDSA",
  );
}

async function requireEndpointSigned(context: HandlerContext, id: string): Promise<string> {
  const [found] = await db
    .select({ id: endpoint.id, publicKey: endpoint.publicKey })
    .from(endpoint)
    .where(eq(endpoint.id, id));
  if (!found) {
    throw new ConnectError(`The console has no endpoint ${id}`, Code.NotFound);
  }
  if (found.publicKey === null) {
    throw new ConnectError("This endpoint has published no key", Code.Unauthenticated);
  }
  const bearer = context.requestHeader.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!bearer) {
    throw new ConnectError("A token the endpoint signed is required", Code.Unauthenticated);
  }
  try {
    await jwtVerify(bearer, await verifying(found.publicKey), {
      issuer: found.id,
      subject: found.id,
      audience: consoleOrigin(),
      algorithms: ["EdDSA"],
      maxTokenAge: "5m",
      clockTolerance: 30,
    });
  } catch {
    throw new ConnectError("The token is not one this endpoint signed", Code.Unauthenticated);
  }
  return found.id;
}

function written(row: Endpoint | undefined) {
  if (!row) {
    throw new ConnectError("the write returned no endpoint", Code.Internal);
  }
  return { endpoint: endpointMessage(resolvedRow(row)) };
}

export const endpointService: ServiceImpl<typeof EndpointService> = {
  async upsert(request, context) {
    const session = await requireAdministeringSession(context);
    const target = request.target === "" ? null : request.target;
    try {
      const [saved] = await db
        .insert(endpoint)
        .values({
          id: uuidv7(),
          organizationId: session.activeOrganizationId,
          name: request.name,
          target,
          vendor: request.vendor,
          reach: "dial",
        })
        .onConflictDoUpdate({
          target: [endpoint.organizationId, endpoint.name],
          set: { target, vendor: request.vendor, reach: "dial" },
        })
        .returning();
      return written(saved);
    } catch (thrown) {
      if (isUniqueViolation(thrown)) {
        throw new ConnectError(
          `Another endpoint of this organization serves ${request.target}: remove it first, or upsert it by its own name`,
          Code.AlreadyExists,
        );
      }
      throw thrown;
    }
  },

  async list(_request, context) {
    const rows = await endpointsOf(sessionOf(context).activeOrganizationId);
    return { endpoints: rows.map(endpointMessage) };
  },

  async setAddress(request, context) {
    const session = await requireAdministeringSession(context);
    const id = await ownedEndpointId(session.activeOrganizationId, request.id);
    const [saved] = await db
      .update(endpoint)
      .set({
        url: request.url,
        ...(request.publicKey !== undefined && { publicKey: request.publicKey }),
        ...(request.tlsPin !== undefined && { tlsPin: request.tlsPin }),
        ...(computeKinds[request.compute] !== undefined && {
          compute: computeKinds[request.compute],
        }),
      })
      .where(eq(endpoint.id, id))
      .returning();
    return written(saved);
  },

  async remove(request, context) {
    const session = await requireAdministeringSession(context);
    const id = await ownedEndpointId(session.activeOrganizationId, request.id);
    await db.delete(endpoint).where(eq(endpoint.id, id));
    return {};
  },

  async heartbeat(request, context) {
    const id = await requireEndpointSigned(context, request.id);
    const ungrantable = refusedScope(Role.OWNER, USER_SCOPES, request.allowedScopes);
    if (ungrantable) {
      throw new ConnectError(
        `An endpoint allows only scopes a person can hold, not ${scopeName(ungrantable.scope)}`,
        Code.InvalidArgument,
      );
    }
    const now = new Date();
    await db
      .update(endpoint)
      .set({
        connectedAt: sql`coalesce(${endpoint.connectedAt}, ${sql.param(now, endpoint.connectedAt)})`,
        lastSeenAt: now,
        version: request.version || null,
        services: request.services,
        allowedScopes: request.allowedScopes.map(claimOf),
      })
      .where(eq(endpoint.id, id));
    return {};
  },

  async bindRunner(request, context) {
    const session = await requireAdministeringSession(context);
    return answered(
      await bindRunner(session.activeOrganizationId, {
        projectId: request.projectId,
        tier: tierNamed(request.tier),
        runnerId: request.runnerId,
        credentials: request.credentials,
      }),
    );
  },

  async unbindRunner(request, context) {
    const session = await requireAdministeringSession(context);
    return answered(
      await unbindRunner(session.activeOrganizationId, request.projectId, tierNamed(request.tier)),
    );
  },

  async resolveRunner(request, context) {
    return answered(
      await resolveRunner(sessionOf(context).activeOrganizationId, {
        projectId: request.projectId,
        tier: tierNamed(request.tier),
        provider: request.provider,
      }),
    );
  },
};
