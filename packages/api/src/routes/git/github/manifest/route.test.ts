import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import { gitApp } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { envKeyStore, gitRuntime } from "@console/git";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createTestSessionWithOrganization,
  createTestSessionWithRole,
} from "../../../../../test/auth-harness";
import { manifestCallback } from "./callback/route";
import { startManifest } from "./route";

beforeAll(async () => {
  await setupTestDatabase();
});

function start(headers: Headers, body: unknown = {}) {
  return new Request("http://localhost/api/git/github/manifest", {
    method: "POST",
    headers: { ...Object.fromEntries(headers), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callback(headers: Headers, query: Record<string, string>) {
  const url = new URL("http://localhost/api/git/github/manifest/callback");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Request(url, { headers });
}

const conversion = {
  id: 4242,
  slug: "acme-ocel",
  client_id: "Iv1.abc",
  client_secret: "client-secret",
  webhook_secret: "whsec",
  pem: "PEM",
  html_url: "https://github.com/apps/acme-ocel",
};

const keys = envKeyStore(randomBytes(32).toString("base64"));
const git = gitRuntime(keys, {
  fetch: async () => Response.json(conversion, { status: 201 }),
});

describe("POST /api/git/github/manifest", () => {
  it("refuses a caller with no session", async () => {
    const response = await startManifest(start(new Headers()), git);
    expect(response.status).toBe(401);
  });

  it("refuses a member who does not administer the organization", async () => {
    const owner = await createTestSessionWithOrganization();
    const member = await createTestSessionWithRole(owner.organization.id, "member");
    try {
      expect((await startManifest(start(member.headers), git)).status).toBe(403);
    } finally {
      await member.cleanup();
      await owner.cleanup();
    }
  });

  it("hands an administrator the manifest, the GitHub address to post it to, and a state", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const response = await startManifest(start(session.headers), git);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.url).toBe(`https://github.com/settings/apps/new?state=${body.state}`);
      expect(body.manifest.hook_attributes.url).toMatch(
        /^http:\/\/localhost:3000\/api\/git\/github\/[^/]+\/webhooks$/,
      );
      expect(body.manifest.redirect_url).toBe(
        "http://localhost:3000/api/git/github/manifest/callback",
      );
    } finally {
      await session.cleanup();
    }
  });

  it("registers the app on a GitHub organization when asked", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const response = await startManifest(start(session.headers, { owner: "acme-inc" }), git);
      const body = await response.json();
      expect(body.url).toBe(
        `https://github.com/organizations/acme-inc/settings/apps/new?state=${body.state}`,
      );
    } finally {
      await session.cleanup();
    }
  });

  it("tells an administrator the console has no git integrations when it has no key", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      expect((await startManifest(start(session.headers), undefined)).status).toBe(503);
    } finally {
      await session.cleanup();
    }
  });

  it("names each app it registers differently, so registering again never collides", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const names = await Promise.all(
        [1, 2].map(async () => {
          const body = await (await startManifest(start(session.headers), git)).json();
          return body.manifest.name as string;
        }),
      );
      expect(names[0]).not.toBe(names[1]);
    } finally {
      await session.cleanup();
    }
  });

  it("refuses an owner that is not a GitHub login", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const response = await startManifest(start(session.headers, { owner: "../evil?x=" }), git);
      expect(response.status).toBe(400);
    } finally {
      await session.cleanup();
    }
  });
});

describe("GET /api/git/github/manifest/callback", () => {
  async function begin(session: Awaited<ReturnType<typeof createTestSessionWithOrganization>>) {
    const body = await (await startManifest(start(session.headers), git)).json();
    const appRowId = new URL(body.manifest.hook_attributes.url).pathname.split("/")[4] ?? "";
    return { state: body.state as string, appRowId };
  }

  it("stores the converted app under the organization and sends the creator to install it", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const { state, appRowId } = await begin(session);

      const response = await manifestCallback(callback(session.headers, { code: "c", state }), git);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://github.com/apps/acme-ocel/installations/new",
      );
      const [row] = await db.select().from(gitApp).where(eq(gitApp.id, appRowId));
      expect(row).toMatchObject({
        organizationId: session.organization.id,
        kind: "github",
        appId: "4242",
        slug: "acme-ocel",
      });
      expect(row?.privateKeyEnc).not.toContain("PEM");
    } finally {
      await session.cleanup();
      await db.delete(gitApp).where(eq(gitApp.appId, "4242"));
    }
  });

  it("stores the app once when GitHub's redirect is replayed, and sends the creator on to install", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const { state } = await begin(session);
      const first = await manifestCallback(callback(session.headers, { code: "c", state }), git);
      const again = await manifestCallback(callback(session.headers, { code: "c", state }), git);

      expect(first.headers.get("location")).toBe(
        "https://github.com/apps/acme-ocel/installations/new",
      );
      expect(again.headers.get("location")).toBe(
        "https://github.com/apps/acme-ocel/installations/new",
      );
      expect(await db.select().from(gitApp).where(eq(gitApp.appId, "4242"))).toHaveLength(1);
    } finally {
      await session.cleanup();
      await db.delete(gitApp).where(eq(gitApp.appId, "4242"));
    }
  });

  it("tells the creator the app GitHub made was not saved", async () => {
    const holder = await createTestSessionWithOrganization();
    const session = await createTestSessionWithOrganization();
    try {
      await git.store.createOrganizationApp({
        id: crypto.randomUUID(),
        organizationId: holder.organization.id,
        kind: "github",
        appId: "4242",
        slug: "already-here",
        privateKey: "k",
        webhookSecret: "w",
        clientId: "c",
        clientSecret: "s",
      });
      const { state, appRowId } = await begin(session);

      const response = await manifestCallback(callback(session.headers, { code: "c", state }), git);

      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/organization/git?error=unsaved",
      );
      expect(await db.select().from(gitApp).where(eq(gitApp.id, appRowId))).toEqual([]);
    } finally {
      await holder.cleanup();
      await session.cleanup();
      await db.delete(gitApp).where(eq(gitApp.appId, "4242"));
    }
  });

  it("refuses a state forged for another organization", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const response = await manifestCallback(
        callback(session.headers, { code: "c", state: "forged.state" }),
        git,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/organization/git?error=state",
      );
      expect(await db.select().from(gitApp).where(eq(gitApp.appId, "4242"))).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });

  it("refuses a state that another person started", async () => {
    const starter = await createTestSessionWithOrganization();
    const other = await createTestSessionWithOrganization();
    try {
      const { state } = await begin(starter);
      const response = await manifestCallback(callback(other.headers, { code: "c", state }), git);
      expect(response.headers.get("location")).toContain("error=state");
      expect(await db.select().from(gitApp).where(eq(gitApp.appId, "4242"))).toEqual([]);
    } finally {
      await starter.cleanup();
      await other.cleanup();
    }
  });

  it("reports GitHub refusing the code, storing nothing", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const { state } = await begin(session);
      const refused = gitRuntime(keys, {
        fetch: async () => Response.json({ message: "Not Found" }, { status: 404 }),
      });

      const response = await manifestCallback(
        callback(session.headers, { code: "c", state }),
        refused,
      );

      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/organization/git?error=github",
      );
    } finally {
      await session.cleanup();
    }
  });

  it("sends a caller with no session to the page that signs them in", async () => {
    const response = await manifestCallback(
      callback(new Headers(), { code: "c", state: "s" }),
      git,
    );
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/organization/git?error=session",
    );
  });
});
