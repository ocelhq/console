import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { auth } from "@console/auth";
import { ConsoleService } from "@console/connectors/gen/console/v1/console_pb";
import { setupTestDatabase } from "@console/db/testing";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import packageJson from "../../../package.json";
import {
  createTestSessionWithOrganization,
  createTestSessionWithoutOrganization,
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
    it("returns Unauthenticated with no session", async () => {
      offerCloud();
      expect((await errorOf(consoleService(null).issueCloudToken({}))).code).toBe(
        Code.Unauthenticated,
      );
    });

    it("returns Unauthenticated for a bearer that is not a session", async () => {
      offerCloud();
      expect((await errorOf(consoleService("not-a-session").issueCloudToken({}))).code).toBe(
        Code.Unauthenticated,
      );
    });

    it("returns FailedPrecondition for a session with no active organization", async () => {
      offerCloud();
      const session = await createTestSessionWithoutOrganization();
      try {
        const refused = await errorOf(consoleService(session.token).issueCloudToken({}));
        expect(refused.code).toBe(Code.FailedPrecondition);
        expect(refused.rawMessage).toContain("no active organization");
      } finally {
        await session.cleanup();
      }
    });

    it("returns FailedPrecondition when the console offers no Ocel Cloud", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const refused = await errorOf(consoleService(session.token).issueCloudToken({}));
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
          consoleService(session.token).issueCloudToken({
            scopes: ["cloud.apps.read", "cloud.everything"],
          }),
        );
        expect(refused.code).toBe(Code.InvalidArgument);
        expect(refused.rawMessage).toContain('"cloud.everything" is no Ocel Cloud scope');
      } finally {
        await session.cleanup();
      }
    });

    it("signs a five-minute token for the organization, verifiable at the console's keys", async () => {
      offerCloud();
      const session = await createTestSessionWithOrganization();
      try {
        const issued = await consoleService(session.token).issueCloudToken({});

        expect(decodeProtectedHeader(issued.token).alg).toBe("EdDSA");
        const { payload } = await jwtVerify(issued.token, await consoleKeys(), {
          issuer: consoleOrigin,
          audience: "ocel-cloud",
        });
        expect(payload).toMatchObject({
          sub: `org:${session.organization.id}`,
          act: session.user.id,
          scope: ["cloud.apps.read", "cloud.apps.write"],
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

    it("signs only the scopes asked for, for the configured audience", async () => {
      offerCloud("https://cloud.example.test");
      const session = await createTestSessionWithOrganization();
      try {
        const issued = await consoleService(session.token).issueCloudToken({
          scopes: ["cloud.apps.read"],
        });
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
