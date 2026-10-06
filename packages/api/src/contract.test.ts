import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auth } from "@console/auth/next";
import { db } from "@console/db";
import { connector } from "@console/db/schema";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestSessionWithOrganization } from "../test/auth-harness";
import { setupTestDatabase } from "../test/db";
import { connectorHeartbeat } from "./routes/connectors/[id]/heartbeat/route";
import { deleteConnector, updateConnector } from "./routes/connectors/[id]/route";
import { listConnectors, upsertConnector } from "./routes/connectors/route";
import { createProject, listProjects } from "./routes/projects/route";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Fixture = {
  name: string;
  request: { method: string; path: string; headers?: Record<string, string>; body: Json };
  response: { status: number; body: Json };
  dynamic?: string[];
};

type Binding = Record<string, string>;

type Session = Awaited<ReturnType<typeof createTestSessionWithOrganization>>;

const origin = "http://localhost:3000";
const contractDir = join(import.meta.dirname, "../test/contract");

const fixtures: Fixture[] = readdirSync(contractDir)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(contractDir, file), "utf8")));

function route(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/auth/")) {
    return auth.handler(request);
  }
  const [, api, resource, id, action] = pathname.split("/");
  const handlers: Record<string, ((request: Request) => Promise<Response>) | undefined> =
    api !== "api"
      ? {}
      : resource === "projects" && id === undefined
        ? { GET: listProjects, POST: createProject }
        : resource === "connectors" && id === undefined
          ? { GET: listConnectors, PUT: upsertConnector }
          : resource === "connectors" && action === undefined
            ? {
                PATCH: (request) => updateConnector(request, id),
                DELETE: (request) => deleteConnector(request, id),
              }
            : resource === "connectors" && action === "heartbeat"
              ? { POST: (request) => connectorHeartbeat(request, id) }
              : {};
  const handler = handlers[request.method];
  if (!handler) {
    throw new Error(`the console routes no ${request.method} ${pathname}`);
  }
  return handler(request);
}

function substitute(text: string, binding: Binding): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => {
    const value = binding[key];
    if (value === undefined) {
      throw new Error(`the fixture uses {{${key}}}, which this setup does not bind`);
    }
    return value;
  });
}

function resolve(value: Json, binding: Binding): Json {
  if (typeof value === "string") {
    return substitute(value, binding);
  }
  if (Array.isArray(value)) {
    return value.map((element) => resolve(element, binding));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, element]) => [key, resolve(element, binding)]),
    );
  }
  return value;
}

function jsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function mismatches(path: string, want: Json, got: unknown, dynamic: Set<string>): string[] {
  if (jsonType(want) !== jsonType(got)) {
    return [
      `${path} is ${JSON.stringify(got)}, want a ${jsonType(want)} like ${JSON.stringify(want)}`,
    ];
  }
  if (dynamic.has(path)) {
    return [];
  }
  if (Array.isArray(want)) {
    const elements = got as unknown[];
    if (elements.length !== want.length) {
      return [`${path} holds ${elements.length} elements, want ${want.length}`];
    }
    return want.flatMap((element, i) => mismatches(`${path}[${i}]`, element, elements[i], dynamic));
  }
  if (want !== null && typeof want === "object") {
    const fields = got as Record<string, unknown>;
    return Object.entries(want).flatMap(([key, element]) =>
      key in fields
        ? mismatches(`${path}.${key}`, element, fields[key], dynamic)
        : [`${path}.${key} is missing`],
    );
  }
  return want === got ? [] : [`${path} is ${JSON.stringify(got)}, want ${JSON.stringify(want)}`];
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { x } = publicKey.export({ format: "jwk" }) as { x: string };
  return { privateKey, publicKey: Buffer.from(x, "base64url").toString("base64") };
}

function mintHeartbeatToken(privateKey: KeyObject, id: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(id)
    .setSubject(id)
    .setAudience(origin)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function send(
  method: string,
  path: string,
  session: Session | null,
  body?: Json,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (session) {
    headers.Authorization = `Bearer ${session.token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return route(
    new Request(origin + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function sendOk(method: string, path: string, session: Session | null, body?: Json) {
  const response = await send(method, path, session, body);
  if (!response.ok) {
    throw new Error(
      `setup ${method} ${path} answered ${response.status}: ${await response.text()}`,
    );
  }
  return response.status === 204 ? null : response.json();
}

async function requestDeviceCode() {
  return sendOk("POST", "/api/auth/device/code", null, { client_id: "ocel-cli" });
}

async function registerConnector(session: Session): Promise<string> {
  const registered = await sendOk("PUT", "/api/connectors", session, {
    target: "vps/sha256:abc/ocel",
    vendor: "vps",
  });
  return registered.id;
}

async function registerAddressedConnector(session: Session) {
  const id = await registerConnector(session);
  const keys = keyPair();
  await sendOk("PATCH", `/api/connectors/${id}`, session, {
    url: "https://connector.example.test",
    publicKey: keys.publicKey,
    compute: "container",
  });
  return { id, keys };
}

const setups: Record<string, (session: Session) => Promise<Binding>> = {
  "device-code": async () => ({}),
  "device-token-pending": async () => ({ "device.code": (await requestDeviceCode()).device_code }),
  "device-token": async (session) => {
    const code = await requestDeviceCode();
    await sendOk("GET", `/api/auth/device?user_code=${code.user_code}`, session);
    await sendOk("POST", "/api/auth/device/approve", session, { userCode: code.user_code });
    return { "device.code": code.device_code };
  },
  session: async () => ({}),
  "organization-list": async () => ({}),
  "organization-set-active": async () => ({}),
  "sign-out": async () => ({}),
  "projects-list": async (session) => {
    const created = await sendOk("POST", "/api/projects", session, { name: "Shop", slug: "shop" });
    return { "project.id": created.id };
  },
  "projects-list-signed-out": async () => ({}),
  "projects-create": async () => ({}),
  "projects-create-conflict": async (session) => {
    await sendOk("POST", "/api/projects", session, { name: "Shop", slug: "shop" });
    return {};
  },
  "connectors-list": async (session) => {
    const { id, keys } = await registerAddressedConnector(session);
    const beat = await connectorHeartbeat(
      new Request(`${origin}/api/connectors/${id}/heartbeat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await mintHeartbeatToken(keys.privateKey, id)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: "0.0.0-alpha", capabilities: ["variables.read"] }),
      }),
      id,
    );
    expect(beat.status).toBe(204);
    await db
      .update(connector)
      .set({
        lastDenied: {
          verb: "set",
          at: "2026-01-02T03:04:05.678Z",
          message: "the token has no variables.write scope",
        },
      })
      .where(eq(connector.id, id));
    return { "connector.id": id, "connector.publicKey": keys.publicKey };
  },
  "connectors-upsert": async () => ({}),
  "connectors-set-address": async (session) => ({
    "connector.id": await registerConnector(session),
    "connector.publicKey": keyPair().publicKey,
  }),
  "connectors-remove": async (session) => ({ "connector.id": await registerConnector(session) }),
  "connector-heartbeat": async (session) => {
    const { id, keys } = await registerAddressedConnector(session);
    return {
      "connector.id": id,
      "connector.token": await mintHeartbeatToken(keys.privateKey, id),
    };
  },
  "connector-heartbeat-unknown": async () => {
    const id = uuidv7();
    return {
      "connector.id": id,
      "connector.token": await mintHeartbeatToken(keyPair().privateKey, id),
    };
  },
};

describe("the requests the ocel CLI and connector send", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("are pinned at an ocel commit, each with a setup here", () => {
    expect(readFileSync(join(contractDir, "OCEL_REF"), "utf8").trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(fixtures.map((fixture) => fixture.name).sort()).toEqual(Object.keys(setups).sort());
  });

  for (const fixture of fixtures) {
    it(`answer ${fixture.name} as the fixture says`, async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const binding: Binding = {
          "session.token": session.token,
          "organization.id": session.organization.id,
          "organization.slug": session.organization.slug,
          "user.email": session.user.email,
          ...(await setups[fixture.name](session)),
        };
        const headers = Object.fromEntries(
          Object.entries(fixture.request.headers ?? {}).map(([name, value]) => [
            name,
            substitute(value, binding),
          ]),
        );
        const body = resolve(fixture.request.body, binding);
        const response = await route(
          new Request(origin + substitute(fixture.request.path, binding), {
            method: fixture.request.method,
            headers,
            body: body === null ? undefined : JSON.stringify(body),
          }),
        );

        const text = await response.text();
        expect(response.status, text).toBe(fixture.response.status);
        if (fixture.response.body !== null) {
          const want = resolve(fixture.response.body, binding);
          expect(mismatches("$", want, JSON.parse(text), new Set(fixture.dynamic))).toEqual([]);
        }
      } finally {
        await session.cleanup();
      }
    });
  }
});
