import { Role, Scope, USER_SCOPES } from "@console/connectors";
import { ProviderService } from "@console/connectors/gen/provider/contract/v1/contract_pb";
import { VariableStoreService } from "@console/connectors/gen/provider/variablestore/v1/variablestore_pb";
import { RunnerService } from "@console/connectors/gen/runner/v1/runner_pb";
import { db } from "@console/db";
import { endpoint, organization } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { pg } from "@console/infra";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { consoleMember } from "./member";
import { reachOf } from "./reach";
import { endpointOf, endpointServing, runnersOf } from "./resolve";

const offered = vi.hoisted(() => ({
  offer: undefined as
    | { apiUrl: string; providerUrl: string; audience: string; version: string }
    | undefined,
}));

vi.mock("./offer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./offer")>()),
  readCloudOffer: () => offered.offer,
}));

const cloudOffer = {
  apiUrl: "https://cloud.example.test/api",
  providerUrl: "https://provider.cloud.example.test",
  audience: "ocel-cloud-audience",
  version: "0.0.9",
};

const orgId = `org-${crypto.randomUUID()}`;
const runnerId = crypto.randomUUID();
const controlId = crypto.randomUUID();

beforeAll(async () => {
  await setupTestDatabase();
  await db
    .insert(organization)
    .values({ id: orgId, name: "A", slug: orgId, createdAt: new Date() });
  await db.insert(endpoint).values([
    {
      id: runnerId,
      organizationId: orgId,
      name: "box",
      vendor: "vps",
      url: "https://box.example.com",
      services: [RunnerService.typeName],
      allowedScopes: ["apps.read", "apps.write"],
    },
    {
      id: controlId,
      organizationId: orgId,
      name: "aws-main",
      target: "aws/123456789012/eu-west-1/main",
      vendor: "aws",
      url: "https://connector.example.com",
      services: [ProviderService.typeName, VariableStoreService.typeName],
      allowedScopes: ["apps.read", "variables.read"],
    },
  ]);
});

afterEach(() => {
  offered.offer = undefined;
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
  await pg.end();
});

describe("endpointOf", () => {
  it("synthesises Ocel Cloud's endpoint while the console offers it, and nothing otherwise", async () => {
    expect(await endpointOf(orgId, "ocel-cloud")).toBeUndefined();

    offered.offer = cloudOffer;

    expect(await endpointOf(orgId, "ocel-cloud")).toMatchObject({
      id: "ocel-cloud",
      name: "ocel-cloud",
      target: "ocel/cloud",
      url: cloudOffer.apiUrl,
      controlUrl: cloudOffer.providerUrl,
      audience: cloudOffer.audience,
      allowedScopes: USER_SCOPES,
      online: true,
    });
  });

  it("serves Ocel Cloud's control calls only where the console offers its provider", async () => {
    offered.offer = { ...cloudOffer, providerUrl: "" };

    expect((await endpointServing(orgId, "ocel/cloud"))?.services).toEqual([
      RunnerService.typeName,
    ]);
  });

  it("resolves an endpoint row with its id as the audience, and only within its organization", async () => {
    expect(await endpointOf(orgId, controlId)).toMatchObject({
      name: "aws-main",
      audience: controlId,
      url: "https://connector.example.com",
      controlUrl: "https://connector.example.com",
      allowedScopes: [Scope.APPS_READ, Scope.VARIABLES_READ],
      online: false,
    });
    expect(await endpointOf("another-org", controlId)).toBeUndefined();
  });
});

describe("runnersOf", () => {
  it("lists Ocel Cloud's runner while offered, then the endpoints that serve a runner", async () => {
    offered.offer = cloudOffer;

    expect((await runnersOf(orgId)).map((runner) => runner.id)).toEqual(["ocel-cloud", runnerId]);
  });
});

async function reached(id: string, role = Role.MEMBER) {
  const endpoint = await endpointOf(orgId, id);
  const reach = endpoint && reachOf({ userId: "u", organizationId: orgId, role }, endpoint);
  if (!reach) throw new Error(`endpoint ${id} is unreachable`);
  return reach;
}

describe("reachOf", () => {
  it("signs each call's token with that call's scope alone", async () => {
    const endpoint = await endpointOf(orgId, runnerId);
    const reach = endpoint && reachOf(consoleMember(orgId), endpoint);

    const token = await reach?.at.authorize(RunnerService.method.cancelJob);

    expect(decodeJwt(token ?? "")).toMatchObject({ aud: runnerId, scope: ["apps.write"] });
  });

  it("refuses before calling what the role or the endpoint does not allow", async () => {
    const owner = await reached(controlId, Role.OWNER);

    expect(owner.serves(VariableStoreService.method.listValues)).toBe(true);
    expect(owner.serves(VariableStoreService.method.setValue)).toBe(false);
    expect(owner.serves(RunnerService.method.getJob)).toBe(false);
    await expect(owner.at.authorize(VariableStoreService.method.setValue)).rejects.toThrow(
      /allows/,
    );
  });
});
