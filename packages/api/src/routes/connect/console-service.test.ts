import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { auth } from "@console/auth";
import { ConsoleService } from "@console/connectors/gen/console/v1/console_pb";
import { setupTestDatabase } from "@console/db/testing";
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import packageJson from "../../../package.json";
import {
  createTestSessionWithOrganization,
  createTestSessionWithoutOrganization,
  createTestSessionWithRole,
} from "../../../test/auth-harness";
import { serviceClient } from "../../../test/connect-harness";
import type { CloudOffer } from "./cloud";

const offered = vi.hoisted(() => ({ cloud: undefined as CloudOffer | undefined }));

vi.mock("./cloud", () => ({ readCloudOffer: () => offered.cloud }));

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
  };
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
    it("answers with no session", async () => {
      const described = await consoleService(null).describe({});
      expect(described.consoleVersion).toBe(packageJson.version);
    });

    it("answers a bearer that is not a session", async () => {
      const described = await consoleService("not-a-session").describe({});
      expect(described.consoleVersion).toBe(packageJson.version);
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
      });
    });
  });

  describe("IssueCloudToken", () => {
    const read = ["cloud.apps.read"];

    function issue(
      bearer: string | null,
      organizationId: string,
      scopes: readonly string[] = read,
    ) {
      return consoleService(bearer).issueCloudToken({ organizationId, scopes: [...scopes] });
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

    it("returns InvalidArgument without an organization or a scope", async () => {
      offerCloud();
      const session = await createTestSessionWithOrganization();
      try {
        expect((await errorOf(issue(session.token, ""))).code).toBe(Code.InvalidArgument);
        expect((await errorOf(issue(session.token, session.organization.id, []))).code).toBe(
          Code.InvalidArgument,
        );
      } finally {
        await session.cleanup();
      }
    });

    it("returns FailedPrecondition when the console offers no Ocel Cloud", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const refused = await errorOf(issue(session.token, session.organization.id));
        expect(refused.code).toBe(Code.FailedPrecondition);
        expect(refused.rawMessage).toContain("offers no Ocel Cloud");
      } finally {
        await session.cleanup();
      }
    });

    it("returns InvalidArgument for a scope Ocel Cloud does not know", async () => {
      offerCloud();
      const session = await createTestSessionWithOrganization();
      try {
        const refused = await errorOf(
          issue(session.token, session.organization.id, ["cloud.apps.read", "cloud.everything"]),
        );
        expect(refused.code).toBe(Code.InvalidArgument);
        expect(refused.rawMessage).toContain('"cloud.everything" is no Ocel Cloud scope');
      } finally {
        await session.cleanup();
      }
    });

    it.each([
      ["member", ["cloud.apps.read", "cloud.apps.write"]],
      ["admin", ["cloud.apps.read", "cloud.apps.write", "cloud.variables.write"]],
      [
        "owner",
        ["cloud.apps.read", "cloud.apps.write", "cloud.variables.write", "cloud.variables.reveal"],
      ],
    ] as const)("grants a %s every scope of its role", async (role, scopes) => {
      offerCloud();
      const owner = await createTestSessionWithOrganization();
      const joined = await createTestSessionWithRole(owner.organization.id, role);
      try {
        const issued = await issue(joined.token, owner.organization.id, scopes);

        expect(decodeJwt(issued.token).scope).toEqual(scopes);
      } finally {
        await joined.cleanup();
        await owner.cleanup();
      }
    });

    it.each([
      ["member", "cloud.variables.write"],
      ["member", "cloud.variables.reveal"],
      ["admin", "cloud.variables.reveal"],
    ] as const)("returns PermissionDenied when a %s asks for %s", async (role, lacked) => {
      offerCloud();
      const owner = await createTestSessionWithOrganization();
      const joined = await createTestSessionWithRole(owner.organization.id, role);
      try {
        const refused = await errorOf(
          issue(joined.token, owner.organization.id, ["cloud.apps.read", lacked]),
        );
        expect(refused.code).toBe(Code.PermissionDenied);
        expect(refused.rawMessage).toContain(lacked);
      } finally {
        await joined.cleanup();
        await owner.cleanup();
      }
    });

    it("never grants cloud.provider, even to an owner", async () => {
      offerCloud();
      const session = await createTestSessionWithOrganization();
      try {
        const refused = await errorOf(
          issue(session.token, session.organization.id, ["cloud.provider"]),
        );
        expect(refused.code).toBe(Code.PermissionDenied);
        expect(refused.rawMessage).toContain("cloud.provider");
      } finally {
        await session.cleanup();
      }
    });

    it("signs a five-minute token for the organization, verifiable at the console's keys", async () => {
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
          scope: ["cloud.apps.read"],
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

    it("signs for the configured audience", async () => {
      offerCloud("https://cloud.example.test");
      const session = await createTestSessionWithOrganization();
      try {
        const issued = await issue(session.token, session.organization.id);
        const { payload } = await jwtVerify(issued.token, await consoleKeys(), {
          audience: "https://cloud.example.test",
        });
        expect(payload.scope).toEqual(["cloud.apps.read"]);
      } finally {
        await session.cleanup();
      }
    });
  });
});
