import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import { gitApp } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { envKeyStore, gitRuntime, systemAppId } from "@console/git";
import { CLIENT_SECRET, fakeGithub, PRIVATE_KEY } from "@console/git/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestSessionWithOrganization,
  createTestSessionWithRole,
} from "../../../../../test/auth-harness";
import { githubAuthorized } from "./authorized/route";
import { githubSetup } from "./setup/route";

const SYSTEM = systemAppId("github");
const github = fakeGithub();
const git = gitRuntime(envKeyStore(randomBytes(32).toString("base64")), { fetch: github.fetch });
const suffix = crypto.randomUUID();

type Session = Awaited<ReturnType<typeof createTestSessionWithOrganization>>;

function get(path: string, headers: Headers, query: Record<string, string>) {
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Request(url, { headers });
}

const setup = (session: { headers: Headers }, appRowId: string, query: Record<string, string>) =>
  githubSetup(get(`/api/git/github/${appRowId}/setup`, session.headers, query), appRowId, git);

const authorized = (
  session: { headers: Headers },
  appRowId: string,
  query: Record<string, string>,
) =>
  githubAuthorized(
    get(`/api/git/github/${appRowId}/authorized`, session.headers, query),
    appRowId,
    git,
  );

async function install(
  session: Session,
  appRowId: string,
  options: {
    installation: string;
    reachable: { id: number; login: string }[];
    role?: "admin" | "member";
  },
) {
  const started = await setup(session, appRowId, {
    installation_id: options.installation,
    setup_action: "install",
  });
  const location = new URL(started.headers.get("location") ?? "");
  const code = `code-${crypto.randomUUID()}`;
  const token = `ghu_${crypto.randomUUID()}`;
  github.oauth.codes.set(code, token);
  github.oauth.people.set(token, {
    id: 1,
    login: "person",
    roles: Object.fromEntries(
      options.reachable.map(({ login }) => [login, options.role ?? "admin"]),
    ),
  });
  github.oauth.userInstallations.set(
    token,
    options.reachable.map(({ id, login }) => ({
      id,
      account: { id: 1000 + id, login, type: "Organization" as const },
    })),
  );
  return authorized(session, appRowId, {
    code,
    state: location.searchParams.get("state") ?? "",
  });
}

const credentials = (appId: string) => ({
  appId,
  slug: `slug-${appId}`,
  privateKey: PRIVATE_KEY,
  webhookSecret: "whsec",
  clientId: `Iv1.${appId}`,
  clientSecret: CLIENT_SECRET,
});

beforeAll(async () => {
  await setupTestDatabase();
  await git.store.replaceSystemApp("github", credentials(`system-${suffix}`));
});

afterAll(async () => {
  await db.delete(gitApp).where(eq(gitApp.id, SYSTEM));
});

describe("GET /api/git/github/:appId/setup", () => {
  it("sends an administrator to GitHub to prove they can reach the installation", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const response = await setup(session, SYSTEM, {
        installation_id: "41",
        setup_action: "install",
      });

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(
        "https://github.com/login/oauth/authorize",
      );
      expect(location.searchParams.get("client_id")).toBe(`Iv1.system-${suffix}`);
      expect(location.searchParams.get("redirect_uri")).toBe(
        `http://localhost:3000/api/git/github/${SYSTEM}/authorized`,
      );
      expect(location.searchParams.get("state")).toBeTruthy();
    } finally {
      await session.cleanup();
    }
  });

  it("refuses a member who does not administer the organization", async () => {
    const owner = await createTestSessionWithOrganization();
    const member = await createTestSessionWithRole(owner.organization.id, "member");
    try {
      const response = await setup(member, SYSTEM, { installation_id: "41" });
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/organization/git?error=forbidden",
      );
    } finally {
      await member.cleanup();
      await owner.cleanup();
    }
  });

  it("refuses an installation id that is not one", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const response = await setup(session, SYSTEM, { installation_id: "1 OR 1=1" });
      expect(response.headers.get("location")).toContain("error=installation");
    } finally {
      await session.cleanup();
    }
  });

  it("says an install waits on GitHub approval when one was only requested", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const response = await setup(session, SYSTEM, { setup_action: "request" });
      expect(response.headers.get("location")).toContain("notice=requested");
    } finally {
      await session.cleanup();
    }
  });

  it("refuses another organization's own app", async () => {
    const holder = await createTestSessionWithOrganization();
    const session = await createTestSessionWithOrganization();
    const appRowId = `app-${crypto.randomUUID()}`;
    try {
      await git.store.createOrganizationApp({
        id: appRowId,
        organizationId: holder.organization.id,
        kind: "github",
        ...credentials(`theirs-${suffix}`),
      });
      const response = await setup(session, appRowId, { installation_id: "41" });
      expect(response.headers.get("location")).toContain("error=app");
    } finally {
      await holder.cleanup();
      await session.cleanup();
    }
  });
});

describe("GET /api/git/github/:appId/authorized", () => {
  it("binds the system app's installation to the organization of the person who installed it", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const response = await install(session, SYSTEM, {
        installation: "501",
        reachable: [
          { id: 500, login: "elsewhere" },
          { id: 501, login: "acme" },
        ],
      });

      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/organization/git?notice=installed",
      );
      expect(await git.store.findInstallation(SYSTEM, "501")).toMatchObject({
        organizationId: session.organization.id,
        account: "acme",
      });
      expect(await git.store.findInstallation(SYSTEM, "500")).toBeUndefined();
    } finally {
      await session.cleanup();
    }
  });

  it("binds an organization's own app the same way", async () => {
    const session = await createTestSessionWithOrganization();
    const appRowId = `app-${crypto.randomUUID()}`;
    try {
      await git.store.createOrganizationApp({
        id: appRowId,
        organizationId: session.organization.id,
        kind: "github",
        ...credentials(`own-${suffix}`),
      });
      const response = await install(session, appRowId, {
        installation: "601",
        reachable: [{ id: 601, login: "acme-own" }],
      });

      expect(response.headers.get("location")).toContain("notice=installed");
      expect(await git.store.findInstallation(appRowId, "601")).toMatchObject({
        organizationId: session.organization.id,
      });
    } finally {
      await session.cleanup();
    }
  });

  it("refuses an installation the person's GitHub account cannot reach", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const response = await install(session, SYSTEM, {
        installation: "777",
        reachable: [{ id: 501, login: "acme" }],
      });

      expect(response.headers.get("location")).toContain("error=unreachable");
      expect(await git.store.findInstallation(SYSTEM, "777")).toBeUndefined();
    } finally {
      await session.cleanup();
    }
  });

  it("refuses an installation on an organization the person is only a member of", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const response = await install(session, SYSTEM, {
        installation: "778",
        reachable: [{ id: 778, login: "acme-member" }],
        role: "member",
      });

      expect(response.headers.get("location")).toContain("error=unreachable");
      expect(await git.store.findInstallation(SYSTEM, "778")).toBeUndefined();
    } finally {
      await session.cleanup();
    }
  });

  it("refuses an installation another organization already bound", async () => {
    const first = await createTestSessionWithOrganization();
    const second = await createTestSessionWithOrganization();
    try {
      await install(first, SYSTEM, { installation: "801", reachable: [{ id: 801, login: "x" }] });
      const response = await install(second, SYSTEM, {
        installation: "801",
        reachable: [{ id: 801, login: "x" }],
      });

      expect(response.headers.get("location")).toContain("error=claimed");
      expect(await git.store.findInstallation(SYSTEM, "801")).toMatchObject({
        organizationId: first.organization.id,
      });
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("refuses a state another person started", async () => {
    const starter = await createTestSessionWithOrganization();
    const other = await createTestSessionWithOrganization();
    try {
      const started = await setup(starter, SYSTEM, { installation_id: "901" });
      const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
      github.oauth.codes.set("code-other", "ghu_other");
      github.oauth.people.set("ghu_other", { id: 2, login: "other", roles: { acme: "admin" } });
      github.oauth.userInstallations.set("ghu_other", [
        { id: 901, account: { id: 1901, login: "acme", type: "Organization" } },
      ]);

      const response = await authorized(other, SYSTEM, { code: "code-other", state });

      expect(response.headers.get("location")).toContain("error=state");
      expect(await git.store.findInstallation(SYSTEM, "901")).toBeUndefined();
    } finally {
      await starter.cleanup();
      await other.cleanup();
    }
  });

  it("refuses a state started for another app", async () => {
    const session = await createTestSessionWithOrganization();
    const appRowId = `app-${crypto.randomUUID()}`;
    try {
      await git.store.createOrganizationApp({
        id: appRowId,
        organizationId: session.organization.id,
        kind: "github",
        ...credentials(`other-app-${suffix}`),
      });
      const started = await setup(session, SYSTEM, { installation_id: "902" });
      const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";

      const response = await authorized(session, appRowId, { code: "c", state });

      expect(response.headers.get("location")).toContain("error=state");
    } finally {
      await session.cleanup();
    }
  });

  it("binds nothing when the person declines on GitHub", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const response = await authorized(session, SYSTEM, { error: "access_denied", state: "s" });
      expect(response.headers.get("location")).toContain("error=denied");
    } finally {
      await session.cleanup();
    }
  });

  it("reports GitHub refusing the code, binding nothing", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const started = await setup(session, SYSTEM, { installation_id: "903" });
      const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";

      const response = await authorized(session, SYSTEM, { code: "never-issued", state });

      expect(response.headers.get("location")).toContain("error=github");
      expect(await git.store.findInstallation(SYSTEM, "903")).toBeUndefined();
    } finally {
      await session.cleanup();
    }
  });
});
