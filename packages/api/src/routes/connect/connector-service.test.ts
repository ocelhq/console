import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { ConnectorReach, ConnectorService } from "@console/connectors/gen/console/v1/connector_pb";
import { ComputeKind } from "@console/connectors/gen/console/v1/deployment_pb";
import { db } from "@console/db";
import { connector } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createTestSessionWithOrganization,
  createTestSessionWithRole,
} from "../../../test/auth-harness";
import { serviceClient } from "../../../test/connect-harness";

const vpsTarget = "vps/sha256:abc/ocel";
const dialled = { target: vpsTarget, vendor: "vps", reach: ConnectorReach.DIAL };

function connectors(bearer: string | null) {
  return serviceClient(ConnectorService, bearer);
}

async function codeOf(call: Promise<unknown>): Promise<Code> {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  return ConnectError.from(error).code;
}

async function registered(bearer: string): Promise<string> {
  const response = await connectors(bearer).upsert(dialled);
  return response.connector?.id ?? "";
}

const origin = "http://localhost:3000";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { x } = publicKey.export({ format: "jwk" }) as { x: string };
  return { privateKey, publicKey: Buffer.from(x, "base64url").toString("base64") };
}

function signed(
  privateKey: KeyObject,
  id: string,
  { audience = origin, issuer = id, issuedAt = Math.floor(Date.now() / 1000) } = {},
) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(issuer)
    .setSubject(id)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 86_400)
    .sign(privateKey);
}

async function paired(bearer: string) {
  const id = await registered(bearer);
  const keys = keyPair();
  await db.update(connector).set({ publicKey: keys.publicKey }).where(eq(connector.id, id));
  return { id, keys };
}

async function row(id: string) {
  const [found] = await db.select().from(connector).where(eq(connector.id, id));
  return found;
}

const beat = { version: "0.0.0-alpha", capabilities: ["variables.read"] };

describe("ConnectorService over Connect", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  describe("the session", () => {
    it("returns Unauthenticated for every RPC with no session", async () => {
      const id = crypto.randomUUID();
      const client = connectors(null);
      expect(await codeOf(client.list({}))).toBe(Code.Unauthenticated);
      expect(await codeOf(client.upsert(dialled))).toBe(Code.Unauthenticated);
      expect(await codeOf(client.remove({ id }))).toBe(Code.Unauthenticated);
      expect(await codeOf(client.setAddress({ id, url: "https://x.test/c" }))).toBe(
        Code.Unauthenticated,
      );
    });
  });

  describe("Upsert", () => {
    it("creates the row in the caller's active organization", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const { connector: saved } = await connectors(session.token).upsert(dialled);

        expect(saved).toMatchObject({
          target: vpsTarget,
          vendor: "vps",
          reach: ConnectorReach.DIAL,
          compute: ComputeKind.UNSPECIFIED,
          organizationId: session.organization.id,
          online: false,
        });
        expect(saved?.url).toBeUndefined();
        expect(saved?.connectedAt).toBeUndefined();
        expect(saved?.id).toBeTruthy();
      } finally {
        await session.cleanup();
      }
    });

    it("converges on the same row for the same target and keeps the address", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);
        await connectors(session.token).setAddress({
          id,
          url: "https://box.example/.ocel/connector",
          publicKey: "aGk=",
        });

        const { connector: again } = await connectors(session.token).upsert(dialled);

        expect(again).toMatchObject({
          id,
          url: "https://box.example/.ocel/connector",
          publicKey: "aGk=",
        });
        const rows = await db
          .select()
          .from(connector)
          .where(eq(connector.organizationId, session.organization.id));
        expect(rows).toHaveLength(1);
      } finally {
        await session.cleanup();
      }
    });

    it("says whether the row it saved is online, as the list does", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);
        const now = new Date();
        await db
          .update(connector)
          .set({ connectedAt: now, lastSeenAt: now })
          .where(eq(connector.id, id));

        const { connector: again } = await connectors(session.token).upsert(dialled);
        expect(again?.online).toBe(true);
      } finally {
        await session.cleanup();
      }
    });

    it("lets two organizations register the same target", async () => {
      const one = await createTestSessionWithOrganization();
      const two = await createTestSessionWithOrganization();
      try {
        expect(await registered(one.token)).not.toBe("");
        expect(await registered(two.token)).not.toBe("");
      } finally {
        await one.cleanup();
        await two.cleanup();
      }
    });

    it("takes a vendor no table in the console names", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const { connector: saved } = await connectors(session.token).upsert({
          target: "azure/sub-1/westeurope/ocel",
          vendor: "azure",
          reach: ConnectorReach.DIAL,
        });
        expect(saved?.vendor).toBe("azure");
      } finally {
        await session.cleanup();
      }
    });

    it("returns InvalidArgument for a target, a vendor or a reach the console cannot store", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const client = connectors(session.token);
        expect(await codeOf(client.upsert({ ...dialled, target: "vps" }))).toBe(
          Code.InvalidArgument,
        );
        expect(await codeOf(client.upsert({ ...dialled, target: "vps/SHA256:abc/ocel" }))).toBe(
          Code.InvalidArgument,
        );
        expect(await codeOf(client.upsert({ ...dialled, vendor: "AWS" }))).toBe(
          Code.InvalidArgument,
        );
        expect(await codeOf(client.upsert({ ...dialled, reach: ConnectorReach.UNSPECIFIED }))).toBe(
          Code.InvalidArgument,
        );
      } finally {
        await session.cleanup();
      }
    });

    it("returns PermissionDenied for a plain member and stores nothing", async () => {
      const session = await createTestSessionWithOrganization();
      const plain = await createTestSessionWithRole(session.organization.id, "member");
      try {
        expect(await codeOf(connectors(plain.token).upsert(dialled))).toBe(Code.PermissionDenied);
        expect(
          await db
            .select()
            .from(connector)
            .where(eq(connector.organizationId, session.organization.id)),
        ).toHaveLength(0);
      } finally {
        await plain.cleanup();
        await session.cleanup();
      }
    });

    it("lets an admin register a target", async () => {
      const session = await createTestSessionWithOrganization();
      const deputy = await createTestSessionWithRole(session.organization.id, "admin");
      try {
        expect(await registered(deputy.token)).not.toBe("");
      } finally {
        await deputy.cleanup();
        await session.cleanup();
      }
    });
  });

  describe("List", () => {
    it("lists the active organization's rows and none from another", async () => {
      const session = await createTestSessionWithOrganization();
      const other = await createTestSessionWithOrganization();
      try {
        await registered(session.token);
        await connectors(other.token).upsert({
          target: "aws/1/eu-west-1/ocel",
          vendor: "aws",
          reach: ConnectorReach.DIAL,
        });

        const { connectors: listed } = await connectors(session.token).list({});

        expect(listed.map((row) => row.target)).toEqual([vpsTarget]);
      } finally {
        await session.cleanup();
        await other.cleanup();
      }
    });

    it("says whether each row is online, so nothing downstream recomputes the threshold", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);
        const online = async () => (await connectors(session.token).list({})).connectors[0]?.online;

        expect(await online()).toBe(false);

        const now = new Date();
        await db
          .update(connector)
          .set({ connectedAt: now, lastSeenAt: now })
          .where(eq(connector.id, id));
        expect(await online()).toBe(true);

        await db
          .update(connector)
          .set({ lastSeenAt: new Date(Date.now() - 600_000) })
          .where(eq(connector.id, id));
        expect(await online()).toBe(false);
      } finally {
        await session.cleanup();
      }
    });

    it("carries the heartbeat's times, capabilities and last refusal", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);
        const seen = new Date("2026-01-02T03:04:05.678Z");
        await db
          .update(connector)
          .set({
            version: "0.0.0-alpha",
            capabilities: ["variables.read"],
            connectedAt: seen,
            lastSeenAt: seen,
            lastDenied: {
              verb: "set",
              at: "2026-01-02T03:04:05.678Z",
              message: "the token has no variables.write scope",
            },
          })
          .where(eq(connector.id, id));

        const [listed] = (await connectors(session.token).list({})).connectors;

        expect(listed?.version).toBe("0.0.0-alpha");
        expect(listed?.capabilities).toEqual(["variables.read"]);
        expect(listed?.connectedAt && timestampDate(listed.connectedAt)).toEqual(seen);
        expect(listed?.lastSeenAt && timestampDate(listed.lastSeenAt)).toEqual(seen);
        expect(listed?.lastDenied).toMatchObject({
          verb: "set",
          message: "the token has no variables.write scope",
        });
        expect(listed?.lastDenied?.at && timestampDate(listed.lastDenied.at)).toEqual(seen);
      } finally {
        await session.cleanup();
      }
    });

    it("lists for a plain member", async () => {
      const session = await createTestSessionWithOrganization();
      const plain = await createTestSessionWithRole(session.organization.id, "member");
      try {
        await registered(session.token);

        expect((await connectors(plain.token).list({})).connectors).toHaveLength(1);
      } finally {
        await plain.cleanup();
        await session.cleanup();
      }
    });
  });

  describe("SetAddress", () => {
    it("writes back the url, the public key, the tls pin and the compute the provider chose", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);

        const { connector: saved } = await connectors(session.token).setAddress({
          id,
          url: "https://box.example/.ocel/connector",
          publicKey: "aGk=",
          tlsPin: "sha256/xyz",
          compute: ComputeKind.SERVERLESS,
        });

        expect(saved).toMatchObject({
          url: "https://box.example/.ocel/connector",
          publicKey: "aGk=",
          tlsPin: "sha256/xyz",
          compute: ComputeKind.SERVERLESS,
        });
      } finally {
        await session.cleanup();
      }
    });

    it("leaves the key, the pin and the compute alone when the request names none", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);
        const client = connectors(session.token);
        await client.setAddress({
          id,
          url: "https://box.example/.ocel/connector",
          publicKey: "aGk=",
          tlsPin: "sha256/xyz",
          compute: ComputeKind.CONTAINER,
        });

        const { connector: saved } = await client.setAddress({
          id,
          url: "https://other.example/.ocel/connector",
        });

        expect(saved).toMatchObject({
          url: "https://other.example/.ocel/connector",
          publicKey: "aGk=",
          tlsPin: "sha256/xyz",
          compute: ComputeKind.CONTAINER,
        });
      } finally {
        await session.cleanup();
      }
    });

    it("says whether the row it wrote back is online, as the list does", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);
        const address = { id, url: "https://box.example/.ocel/connector" };
        expect((await connectors(session.token).setAddress(address)).connector?.online).toBe(false);

        const now = new Date();
        await db
          .update(connector)
          .set({ connectedAt: now, lastSeenAt: now })
          .where(eq(connector.id, id));
        expect((await connectors(session.token).setAddress(address)).connector?.online).toBe(true);
      } finally {
        await session.cleanup();
      }
    });

    it("returns InvalidArgument for a url that is not one", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);
        expect(await codeOf(connectors(session.token).setAddress({ id, url: "box" }))).toBe(
          Code.InvalidArgument,
        );
      } finally {
        await session.cleanup();
      }
    });

    it("returns NotFound for another organization's row", async () => {
      const session = await createTestSessionWithOrganization();
      const other = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);
        expect(
          await codeOf(connectors(other.token).setAddress({ id, url: "https://x.test/c" })),
        ).toBe(Code.NotFound);
      } finally {
        await session.cleanup();
        await other.cleanup();
      }
    });

    it("returns PermissionDenied for a plain member and leaves the url alone", async () => {
      const session = await createTestSessionWithOrganization();
      const plain = await createTestSessionWithRole(session.organization.id, "member");
      try {
        const id = await registered(session.token);

        expect(
          await codeOf(
            connectors(plain.token).setAddress({ id, url: "https://attacker.example/c" }),
          ),
        ).toBe(Code.PermissionDenied);

        const [row] = await db.select().from(connector).where(eq(connector.id, id));
        expect(row?.url).toBeNull();
      } finally {
        await plain.cleanup();
        await session.cleanup();
      }
    });
  });

  describe("Remove", () => {
    it("deletes the row", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);

        await connectors(session.token).remove({ id });

        expect(await db.select().from(connector).where(eq(connector.id, id))).toHaveLength(0);
      } finally {
        await session.cleanup();
      }
    });

    it("returns NotFound for another organization's row and leaves it", async () => {
      const session = await createTestSessionWithOrganization();
      const other = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);

        expect(await codeOf(connectors(other.token).remove({ id }))).toBe(Code.NotFound);
        expect(await db.select().from(connector).where(eq(connector.id, id))).toHaveLength(1);
      } finally {
        await session.cleanup();
        await other.cleanup();
      }
    });

    it("returns PermissionDenied for a plain member and leaves the row", async () => {
      const session = await createTestSessionWithOrganization();
      const plain = await createTestSessionWithRole(session.organization.id, "member");
      try {
        const id = await registered(session.token);

        expect(await codeOf(connectors(plain.token).remove({ id }))).toBe(Code.PermissionDenied);
        expect(await db.select().from(connector).where(eq(connector.id, id))).toHaveLength(1);
      } finally {
        await plain.cleanup();
        await session.cleanup();
      }
    });
  });

  describe("Heartbeat", () => {
    it("moves the liveness columns for a token the connector signed, with no session", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const { id, keys } = await paired(session.token);

        await connectors(await signed(keys.privateKey, id)).heartbeat({ id, ...beat });

        const first = await row(id);
        expect(first.connectedAt).not.toBeNull();
        expect(first.lastSeenAt).not.toBeNull();
        expect(first.version).toBe("0.0.0-alpha");
        expect(first.capabilities).toEqual(["variables.read"]);

        await connectors(await signed(keys.privateKey, id)).heartbeat({ id, ...beat });
        const again = await row(id);
        expect(again.connectedAt?.getTime()).toBe(first.connectedAt?.getTime());
        expect(again.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(
          first.lastSeenAt?.getTime() ?? 0,
        );
      } finally {
        await session.cleanup();
      }
    });

    it("returns NotFound for an id the console has no record of", async () => {
      const id = crypto.randomUUID();
      const keys = keyPair();
      expect(
        await codeOf(connectors(await signed(keys.privateKey, id)).heartbeat({ id, ...beat })),
      ).toBe(Code.NotFound);
    });

    it("returns Unauthenticated, and moves nothing, for a token the connector did not sign as itself", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const { id, keys } = await paired(session.token);
        const stranger = keyPair();
        const hourAgo = Math.floor(Date.now() / 1000) - 3600;
        const refused = {
          "no token": null,
          "the user's session": session.token,
          "another key": await signed(stranger.privateKey, id),
          "another audience": await signed(keys.privateKey, id, {
            audience: "https://elsewhere.test",
          }),
          "another issuer": await signed(keys.privateKey, id, { issuer: crypto.randomUUID() }),
          "minted an hour ago": await signed(keys.privateKey, id, { issuedAt: hourAgo }),
        };
        for (const [name, bearer] of Object.entries(refused)) {
          expect(await codeOf(connectors(bearer).heartbeat({ id, ...beat })), name).toBe(
            Code.Unauthenticated,
          );
        }
        expect((await row(id)).lastSeenAt).toBeNull();
      } finally {
        await session.cleanup();
      }
    });

    it("returns Unauthenticated for a connector that has published no key", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const id = await registered(session.token);
        const keys = keyPair();
        expect(
          await codeOf(connectors(await signed(keys.privateKey, id)).heartbeat({ id, ...beat })),
        ).toBe(Code.Unauthenticated);
      } finally {
        await session.cleanup();
      }
    });
  });
});
