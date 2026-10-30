import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { auth } from "@console/auth";
import { Scope } from "@console/connectors/gen/common/scope/v1/scope_pb";
import { ConsoleService } from "@console/connectors/gen/console/v1/console_pb";
import { db } from "@console/db";
import { endpoint } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import webPackage from "../../../../../apps/web/package.json";
import type { CloudOffer } from "../../../../endpoints/src/offer";
import {
  createTestSessionWithOrganization,
  createTestSessionWithoutOrganization,
  createTestSessionWithRole,
} from "../../../test/auth-harness";
import { serviceClient } from "../../../test/connect-harness";

const offered = vi.hoisted(() => ({ cloud: undefined as CloudOffer | undefined }));

vi.mock("../../../../endpoints/src/offer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../endpoints/src/offer")>()),
  readCloudOffer: () => offered.cloud,
}));

const consoleOrigin = "http://localhost:3000";

function consoleService(bearer: string | null) {
  return serviceClient(ConsoleService, bearer);
}

async function errorOf(call: Promise<unknown>): Promise<ConnectError> {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  return ConnectError.from(error);
}

function offerCloud(audience = "ocel-cloud") {
  offered.cloud = {
    apiUrl: "https://cloud.example.test/api",
    providerUrl: "https://provider.cloud.example.test",
    audience,
    version: "0.0.9",
  };
}

async function endpointOf(organizationId: string, allowed: readonly string[]): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(endpoint).values({
    id,
    organizationId,
    name: `box-${id.slice(0, 8)}`,
    vendor: "vps",
    allowedScopes: [...allowed],
  });
  return id;
}

async function consoleKeys() {
  const response = await auth.handler(new Request(`${consoleOrigin}/api/auth/jwks`));
  return createLocalJWKSet(await response.json());
}

describe("ConsoleService over Connect", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    offered.cloud = undefined;
  });

  describe("Describe", () => {
    it("answers the console app's version with no session", async () => {
      const described = await consoleService(null).describe({});
      expect(described.consoleVersion).toBe(webPackage.version);
    });

    it("answers a bearer that is not a session", async () => {
      const described = await consoleService("not-a-session").describe({});
      expect(described.consoleVersion).toBe(webPackage.version);
    });

    it("offers no Ocel Cloud when none is configured", async () => {
      const described = await consoleService(null).describe({});
      expect(described.cloud).toBeUndefined();
      expect(described.capabilities).toEqual(["deployments.report", "connectors"]);
    });

    it("offers the configured Ocel Cloud", async () => {
      offerCloud();
      const described = await consoleService(null).describe({});
      expect(described.capabilities).toEqual(["deployments.report", "connectors", "cloud"]);
      expect(described.cloud).toMatchObject({
        apiUrl: "https://cloud.example.test/api",
        providerUrl: "https://provider.cloud.example.test",
        audience: "ocel-cloud",
        version: "0.0.9",
      });
    });
  });

  describe("IssueEndpointToken", () => {
    const read = [Scope.APPS_READ];

    function issue(
      bearer: string | null,
      organizationId: string,
      scopes: readonly Scope[] = read,
      endpointId = "ocel-cloud",
    ) {
      return consoleService(bearer).issueEndpointToken({
        organizationId,
        endpointId,
        scopes: [...scopes],
      });
    }

    it("returns Unauthenticated with no session", async () => {
      offerCloud();
      expect((await errorOf(issue(null, "org-1"))).code).toBe(Code.Unauthenticated);
    });

    it("returns Unauthenticated for a bearer that is not a session", async () => {
      offerCloud();
      expect((await errorOf(issue("not-a-session", "org-1"))).code).toBe(Code.Unauthenticated);
    });

    it("returns PermissionDenied for an organization the caller does not belong to", async () => {
      offerCloud();
      const mine = await createTestSessionWithOrganization();
      const theirs = await createTestSessionWithOrganization();
      try {
        const refused = await errorOf(issue(mine.token, theirs.organization.id));
        expect(refused.code).toBe(Code.PermissionDenied);
        expect(refused.rawMessage).toContain(theirs.organization.id);
      } finally {
        await mine.cleanup();
        await theirs.cleanup();
      }
    });

    it("signs for the organization asked for, not the session's active one", async () => {
      offerCloud();
      const named = await createTestSessionWithOrganization();
      const active = await createTestSessionWithOrganization();
      const joined = await createTestSessionWithRole(active.organization.id, "member");
      try {
        await auth.api.addMember({
          body: { userId: joined.user.id, organizationId: named.organization.id, role: "member" },
        });

        const issued = await issue(joined.token, named.organization.id);

        const { payload } = await jwtVerify(issued.token, await consoleKeys(), {
          audience: "ocel-cloud",
        });
        expect(payload.sub).toBe(`org:${named.organization.id}`);
      } finally {
        await joined.cleanup();
        await named.cleanup();
        await active.cleanup();
      }
    });

    it("signs for a member of the organization whose session has no active organization", async () => {
      offerCloud();
      const owner = await createTestSessionWithOrganization();
      const loose = await createTestSessionWithoutOrganization();
      try {
        await auth.api.addMember({
          body: { userId: loose.user.id, organizationId: owner.organization.id, role: "member" },
        });

        const issued = await issue(loose.token, owner.organization.id);

        expect(decodeJwt(issued.token).sub).toBe(`org:${owner.organization.id}`);
      } finally {
        await loose.cleanup();
        await owner.cleanup();
      }
    });

    it("returns InvalidArgument without an organization, an endpoint or a scope", async () => {
      offerCloud();
      const session = await createTestSessionWithOrganization();
      try {
        const organizationId = session.organization.id;
        expect((await errorOf(issue(session.token, ""))).code).toBe(Code.InvalidArgument);
        expect((await errorOf(issue(session.token, organizationId, []))).code).toBe(
          Code.InvalidArgument,
        );
        expect((await errorOf(issue(session.token, organizationId, read, "box"))).code).toBe(
          Code.InvalidArgument,
        );
      } finally {
        await session.cleanup();
      }
    });

    it("returns NotFound for Ocel Cloud when the console offers none", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const refused = await errorOf(issue(session.token, session.organization.id));
        expect(refused.code).toBe(Code.NotFound);
        expect(refused.rawMessage).toContain("No endpoint ocel-cloud");
      } finally {
        await session.cleanup();
      }
    });

    it.each([Scope.JOB, Scope.TARGET_CREDENTIAL])(
      "returns InvalidArgument for scope %s, which only a kind of token carries",
      async (scope) => {
        offerCloud();
        const session = await createTestSessionWithOrganization();
        try {
          const refused = await errorOf(
            issue(session.token, session.organization.id, [Scope.APPS_READ, scope]),
          );
          expect(refused.code).toBe(Code.InvalidArgument);
        } finally {
          await session.cleanup();
        }
      },
    );

    it.each([
      ["member", ["apps.read", "apps.write", "variables.read"]],
      ["admin", ["apps.read", "apps.write", "variables.read", "variables.write"]],
      [
        "owner",
        ["apps.read", "apps.write", "variables.read", "variables.write", "variables.reveal"],
      ],
    ] as const)("grants a %s every scope its role reaches", async (role, claims) => {
      offerCloud();
      const owner = await createTestSessionWithOrganization();
      const joined = await createTestSessionWithRole(owner.organization.id, role);
      const scopes = [
        Scope.APPS_READ,
        Scope.APPS_WRITE,
        Scope.VARIABLES_READ,
        Scope.VARIABLES_WRITE,
        Scope.VARIABLES_REVEAL,
      ].slice(0, claims.length);
      try {
        const issued = await issue(joined.token, owner.organization.id, scopes);

        expect(decodeJwt(issued.token).scope).toEqual(claims);
      } finally {
        await joined.cleanup();
        await owner.cleanup();
      }
    });

    it.each([
      ["member", Scope.VARIABLES_WRITE, "variables.write"],
      ["member", Scope.VARIABLES_REVEAL, "variables.reveal"],
      ["admin", Scope.VARIABLES_REVEAL, "variables.reveal"],
    ] as const)("returns PermissionDenied when a %s asks for %s", async (role, lacked, named) => {
      offerCloud();
      const owner = await createTestSessionWithOrganization();
      const joined = await createTestSessionWithRole(owner.organization.id, role);
      try {
        const refused = await errorOf(
          issue(joined.token, owner.organization.id, [Scope.APPS_READ, lacked]),
        );
        expect(refused.code).toBe(Code.PermissionDenied);
        expect(refused.rawMessage).toContain(named);
      } finally {
        await joined.cleanup();
        await owner.cleanup();
      }
    });

    it("signs a five-minute token for Ocel Cloud, verifiable at the console's keys", async () => {
      offerCloud();
      const session = await createTestSessionWithOrganization();
      try {
        const issued = await issue(session.token, session.organization.id);

        expect(decodeProtectedHeader(issued.token).alg).toBe("EdDSA");
        const { payload } = await jwtVerify(issued.token, await consoleKeys(), {
          issuer: consoleOrigin,
          audience: "ocel-cloud",
        });
        expect(payload).toMatchObject({
          sub: `org:${session.organization.id}`,
          act: session.user.id,
          scope: ["apps.read"],
        });
        expect(payload.jti).toEqual(expect.any(String));
        expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
        expect(issued.expiresAt && timestampDate(issued.expiresAt).getTime()).toBe(
          (payload.exp ?? 0) * 1000,
        );
      } finally {
        await session.cleanup();
      }
    });

    it("signs for Ocel Cloud's configured audience", async () => {
      offerCloud("https://cloud.example.test");
      const session = await createTestSessionWithOrganization();
      try {
        const issued = await issue(session.token, session.organization.id);
        const { payload } = await jwtVerify(issued.token, await consoleKeys(), {
          audience: "https://cloud.example.test",
        });
        expect(payload.scope).toEqual(["apps.read"]);
      } finally {
        await session.cleanup();
      }
    });

    it("signs for a registered endpoint with its id as the audience", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await endpointOf(session.organization.id, ["variables.read", "variables.write"]);

        const issued = await issue(
          session.token,
          session.organization.id,
          [Scope.VARIABLES_WRITE],
          id,
        );

        const { payload } = await jwtVerify(issued.token, await consoleKeys(), { audience: id });
        expect(payload.scope).toEqual(["variables.write"]);
      } finally {
        await session.cleanup();
      }
    });

    it("returns PermissionDenied for a scope the endpoint does not allow, whatever the role", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await endpointOf(session.organization.id, ["variables.read"]);

        const refused = await errorOf(
          issue(session.token, session.organization.id, [Scope.VARIABLES_REVEAL], id),
        );

        expect(refused.code).toBe(Code.PermissionDenied);
        expect(refused.rawMessage).toContain("variables.reveal");
      } finally {
        await session.cleanup();
      }
    });

    it("returns NotFound for another organization's endpoint", async () => {
      const mine = await createTestSessionWithOrganization();
      const theirs = await createTestSessionWithOrganization();
      try {
        const id = await endpointOf(theirs.organization.id, ["variables.read"]);
        const refused = await errorOf(
          issue(mine.token, mine.organization.id, [Scope.VARIABLES_READ], id),
        );
        expect(refused.code).toBe(Code.NotFound);
      } finally {
        await mine.cleanup();
        await theirs.cleanup();
      }
    });
  });
});
