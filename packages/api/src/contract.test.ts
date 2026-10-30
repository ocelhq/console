import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auth } from "@console/auth/next";
import { setupTestDatabase } from "@console/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestSessionWithOrganization } from "../test/auth-harness";
import { CONNECT_PREFIX, connectHandler } from "./routes/connect/route";

const connect = connectHandler({ notify: async () => {}, git: () => undefined });

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
  if (pathname.startsWith(`${CONNECT_PREFIX}/`) && request.method === "POST") {
    return connect(request);
  }
  throw new Error(`the console routes no ${request.method} ${pathname}`);
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

const cloud = {
  "cloud.api_url": "https://cloud.example.test",
  "cloud.provider_url": "https://provider.cloud.example.test",
  "cloud.audience": "ocel-cloud",
};

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
  "console-describe": async () => cloud,
  "endpoint-token-ocel-cloud": async () => ({}),
  "endpoint-token-without-session": async () => ({}),
};

describe("the requests the ocel CLI sends", () => {
  beforeAll(async () => {
    vi.stubEnv("CONSOLE_CLOUD_URL", cloud["cloud.api_url"]);
    vi.stubEnv("CONSOLE_CLOUD_PROVIDER_URL", cloud["cloud.provider_url"]);
    vi.stubEnv("CONSOLE_CLOUD_AUDIENCE", cloud["cloud.audience"]);
    await setupTestDatabase();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
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
