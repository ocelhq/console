import type { DescMethod } from "@console/connectors";
import { ProviderService } from "@console/connectors/gen/provider/contract/v1/contract_pb";
import { VariableStoreService } from "@console/connectors/gen/provider/variablestore/v1/variablestore_pb";
import { db } from "@console/db";
import { endpoint } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { resolvedRow } from "@console/endpoints";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestSessionWithOrganization, createTestSessionWithRole } from "@/test/auth-harness";
import { endpointFor, type Reach, sessionReach } from "./connectors";

const offered = vi.hoisted(() => ({
  offer: undefined as
    | { apiUrl: string; providerUrl: string; audience: string; version: string }
    | undefined,
}));

vi.mock("../../../packages/endpoints/src/offer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/endpoints/src/offer")>()),
  readCloudOffer: () => offered.offer,
}));

const cloudOffer = {
  apiUrl: "https://cloud.example.test/api",
  providerUrl: "https://provider.cloud.example.test",
  audience: "ocel-cloud",
  version: "0.0.9",
};

function claimsOf(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
}

async function claimsFor(reach: Reach | null, call: DescMethod) {
  return claimsOf((await reach?.endpoint.authorize(call)) ?? "");
}

type TestSession = Awaited<ReturnType<typeof createTestSessionWithOrganization>>;

function caller(session: TestSession) {
  return { userId: session.user.id, activeOrganizationId: session.organization.id };
}

beforeAll(async () => {
  await setupTestDatabase();
});

describe("endpointFor", () => {
  beforeEach(() => {
    offered.offer = undefined;
  });

  it("reaches the connector whose target the deploy landed in, not whichever shares the vendor", async () => {
    const session = await createTestSessionWithOrganization();
    const organizationId = session.organization.id;
    try {
      await db.insert(endpoint).values([
        {
          id: `first-${organizationId}`,
          name: "e-first",
          organizationId,
          target: "aws/111111111111/us-east-1/main",
          vendor: "aws",
          compute: "container",
          url: "http://127.0.0.1:7777",
        },
        {
          id: `second-${organizationId}`,
          name: "e-second",
          organizationId,
          target: "aws/222222222222/eu-west-1/main",
          vendor: "aws",
          compute: "serverless",
          url: "http://127.0.0.1:7778",
          allowedScopes: ["variables.read"],
        },
      ]);

      const found = await endpointFor(caller(session), "aws/222222222222/eu-west-1/main");

      expect(found?.endpoint).toMatchObject({
        url: "http://127.0.0.1:7778",
        controlUrl: "http://127.0.0.1:7778",
      });
      const claims = await claimsFor(found, VariableStoreService.method.listValues);
      expect(claims.aud).toBe(`second-${organizationId}`);
    } finally {
      await session.cleanup();
    }
  });

  it("finds nothing for a target no connector claims, nor for a connector with no address", async () => {
    const session = await createTestSessionWithOrganization();
    const organizationId = session.organization.id;
    try {
      await db.insert(endpoint).values({
        id: `silent-${organizationId}`,
        name: "e-silent",
        organizationId,
        target: "aws/555555555555/us-east-1/main",
        vendor: "aws",
      });

      expect(await endpointFor(caller(session), "aws/333333333333/us-east-1/main")).toBeNull();
      expect(await endpointFor(caller(session), "aws/555555555555/us-east-1/main")).toBeNull();
      expect(await endpointFor(caller(session), null)).toBeNull();
    } finally {
      await session.cleanup();
    }
  });

  it("implies Ocel Cloud's provider for its target while the console offers it, in no row", async () => {
    offered.offer = cloudOffer;
    const session = await createTestSessionWithOrganization();
    const organizationId = session.organization.id;
    try {
      await db.insert(endpoint).values({
        id: `shadow-${organizationId}`,
        name: "e-shadow",
        organizationId,
        target: "ocel/cloud",
        vendor: "ocel",
        url: "http://127.0.0.1:7777",
      });

      const found = await endpointFor(caller(session), "ocel/cloud");

      expect(found?.endpoint).toMatchObject({
        url: cloudOffer.apiUrl,
        controlUrl: cloudOffer.providerUrl,
      });
    } finally {
      await session.cleanup();
    }
  });

  it("serves no control call on Ocel Cloud's target while the console offers no provider for it", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      expect(await endpointFor(caller(session), "ocel/cloud")).toBeNull();
      offered.offer = { ...cloudOffer, providerUrl: "" };
      const reach = await endpointFor(caller(session), "ocel/cloud");
      expect(reach?.serves(VariableStoreService.method.listValues)).toBe(false);
      expect(reach?.serves(ProviderService.method.rollback)).toBe(false);
    } finally {
      await session.cleanup();
    }
  });

  it("keeps a target to one endpoint per organization", async () => {
    const session = await createTestSessionWithOrganization();
    const organizationId = session.organization.id;
    try {
      const row = {
        organizationId,
        target: "gcp/ocel-prod/europe-west1/main",
        vendor: "gcp" as const,
        compute: "serverless" as const,
      };
      await db.insert(endpoint).values({ id: `one-${organizationId}`, name: "one", ...row });
      await expect(
        db.insert(endpoint).values({ id: `two-${organizationId}`, name: "two", ...row }),
      ).rejects.toThrow();
    } finally {
      await session.cleanup();
    }
  });
});

describe("Ocel Cloud's reach", () => {
  beforeEach(() => {
    offered.offer = cloudOffer;
  });

  it("signs each call a cloud token carrying only the scope it needs, which the role grants", async () => {
    const session = await createTestSessionWithOrganization();
    const organizationId = session.organization.id;
    const deputy = await createTestSessionWithRole(organizationId, "admin");
    try {
      const reach = await endpointFor(
        { userId: deputy.user.id, activeOrganizationId: organizationId },
        "ocel/cloud",
      );

      const configure = await claimsFor(reach, ProviderService.method.configure);
      const set = await claimsFor(reach, VariableStoreService.method.setValue);
      expect(configure.aud).toBe(cloudOffer.audience);
      expect(configure.scope).toEqual(["apps.read"]);
      expect(set.scope).toEqual(["variables.write"]);
      await expect(
        reach?.endpoint.authorize(VariableStoreService.method.revealValues),
      ).rejects.toThrow(/allows/);
      expect(reach?.ability).toEqual({ write: true, reveal: false });
    } finally {
      await deputy.cleanup();
      await session.cleanup();
    }
  });
});

describe("an endpoint's reach", () => {
  it("signs each call a token for the endpoint carrying only the scope it needs, which its role reaches", async () => {
    const session = await createTestSessionWithOrganization();
    const organizationId = session.organization.id;
    const deputy = await createTestSessionWithRole(organizationId, "member");
    try {
      await db.insert(endpoint).values({
        id: `scoped-${organizationId}`,
        name: "e-scoped",
        organizationId,
        target: "aws/666666666666/us-east-1/main",
        vendor: "aws",
        url: "http://127.0.0.1:7777",
        allowedScopes: ["variables.read", "variables.write", "variables.reveal"],
      });
      const [row] = await db
        .select()
        .from(endpoint)
        .where(eq(endpoint.id, `scoped-${organizationId}`));
      const reach = await sessionReach(
        { userId: deputy.user.id, activeOrganizationId: organizationId },
        resolvedRow(row),
      );

      const listed = await claimsFor(reach, VariableStoreService.method.listValues);
      expect(listed.scope).toEqual(["variables.read"]);
      await expect(reach?.endpoint.authorize(VariableStoreService.method.setValue)).rejects.toThrow(
        /allows/,
      );
      expect(reach?.ability).toEqual({ write: false, reveal: false });
    } finally {
      await deputy.cleanup();
      await session.cleanup();
    }
  });

  it("serves a call only when the endpoint mounts its service and the role reaches its scope", async () => {
    const session = await createTestSessionWithOrganization();
    const organizationId = session.organization.id;
    const deputy = await createTestSessionWithRole(organizationId, "member");
    try {
      await db.insert(endpoint).values({
        id: `serving-${organizationId}`,
        name: "e-serving",
        organizationId,
        target: "aws/777777777777/us-east-1/main",
        vendor: "aws",
        url: "http://127.0.0.1:7777",
        services: ["provider.variablestore.v1.VariableStoreService"],
        allowedScopes: ["apps.write", "variables.read", "variables.write"],
      });
      const [row] = await db
        .select()
        .from(endpoint)
        .where(eq(endpoint.id, `serving-${organizationId}`));
      const owned = await sessionReach(caller(session), resolvedRow(row));
      const membered = await sessionReach(
        { userId: deputy.user.id, activeOrganizationId: organizationId },
        resolvedRow(row),
      );

      expect(owned?.serves(VariableStoreService.method.setValue)).toBe(true);
      expect(membered?.serves(VariableStoreService.method.setValue)).toBe(false);
      expect(owned?.serves(ProviderService.method.rollback)).toBe(false);

      await db
        .update(endpoint)
        .set({ services: ["provider.contract.v1.ProviderService"] })
        .where(eq(endpoint.id, row.id));
      const [mounted] = await db.select().from(endpoint).where(eq(endpoint.id, row.id));
      expect(
        (await sessionReach(caller(session), resolvedRow(mounted)))?.serves(
          ProviderService.method.rollback,
        ),
      ).toBe(true);
    } finally {
      await deputy.cleanup();
      await session.cleanup();
    }
  });

  it("writes what the endpoint refused, and leaves every other refusal unrecorded", async () => {
    const session = await createTestSessionWithOrganization();
    const organizationId = session.organization.id;
    const id = `denied-${organizationId}`;
    try {
      await db.insert(endpoint).values({
        id,
        name: "e-denied",
        organizationId,
        target: "aws/444444444444/us-east-1/main",
        vendor: "aws",
        url: "http://127.0.0.1:7777",
      });
      const [inserted] = await db.select().from(endpoint).where(eq(endpoint.id, id));
      const reach = await sessionReach(caller(session), resolvedRow(inserted));

      await reach?.denied("set", { reason: "offline", message: "nothing answered" });
      const [untouched] = await db.select().from(endpoint).where(eq(endpoint.id, id));
      expect(untouched.lastDenied).toBeNull();

      await reach?.denied("set", {
        reason: "denied",
        message: "the token has no variables.write scope",
      });
      const [row] = await db.select().from(endpoint).where(eq(endpoint.id, id));
      expect(row.lastDenied?.verb).toBe("set");
      expect(row.lastDenied?.message).toBe("the token has no variables.write scope");
      expect(Date.parse(row.lastDenied?.at ?? "")).not.toBeNaN();
    } finally {
      await session.cleanup();
    }
  });
});
