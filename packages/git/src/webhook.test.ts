import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import { gitApp, organization, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { pg } from "@console/infra";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envKeyStore } from "./keystore";
import type { GitEvent, GitProvider, WebhookRequest } from "./provider";
import { gitStore } from "./store";
import { type GitEventContext, webhookHandler } from "./webhook";

const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`;
const appRowId = `app-${suffix}`;
const store = gitStore(envKeyStore(randomBytes(32).toString("base64")));

const repo = { id: "1234", fullName: "acme/web" };

function setup(parsed: GitEvent | undefined, verified = true) {
  const seen: { event: GitEvent; context: GitEventContext }[] = [];
  const handler = webhookHandler({
    store,
    providerFor: () =>
      ({
        verifyWebhook: async () => verified,
        parseEvent: () => parsed,
      }) as unknown as GitProvider,
    onEvent: async (event, context) => {
      seen.push({ event, context });
    },
  });
  const request: WebhookRequest = { headers: new Headers(), body: "{}" };
  return { seen, post: (id = appRowId) => handler(request, id) };
}

beforeAll(async () => {
  await setupTestDatabase();
  await db
    .insert(organization)
    .values({ id: orgId, name: "A", slug: orgId, createdAt: new Date() });
  await store.createOrganizationApp({
    id: appRowId,
    organizationId: orgId,
    kind: "github",
    appId: `gh-${suffix}`,
    slug: "mine",
    privateKey: "k",
    webhookSecret: "s",
    clientId: "c",
    clientSecret: "cs",
  });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
  await db.delete(gitApp).where(eq(gitApp.id, appRowId));
  await pg.end();
});

describe("webhookHandler", () => {
  it("answers 404 for an app it does not hold", async () => {
    const { post } = setup(undefined);
    expect((await post("unknown")).status).toBe(404);
  });

  it("answers 401 to a delivery the provider cannot verify, and tells no one", async () => {
    const { post, seen } = setup({ type: "uninstalled", installation: "1" }, false);
    expect((await post()).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("accepts and ignores an event it has no use for", async () => {
    const { post, seen } = setup(undefined);
    expect((await post()).status).toBe(202);
    expect(seen).toEqual([]);
  });

  it("records an installation of an organization's app under that organization", async () => {
    const { post } = setup({ type: "installed", installation: "555", account: "acme" });
    expect((await post()).status).toBe(202);

    expect(await store.findInstallation(appRowId, "555")).toMatchObject({
      organizationId: orgId,
      account: "acme",
    });
  });

  it("forgets an installation that was removed", async () => {
    const { post } = setup({ type: "uninstalled", installation: "555" });
    await post();
    expect(await store.findInstallation(appRowId, "555")).toBeUndefined();
  });

  it("tells the handler which projects build from the repo an event is about", async () => {
    const installation = await store.recordInstallation({
      gitAppId: appRowId,
      organizationId: orgId,
      externalId: "556",
      account: "acme",
    });
    await db
      .insert(project)
      .values({ id: `p-${suffix}`, organizationId: orgId, name: "P", slug: "p" });
    await store.linkProjectRepo({
      projectId: `p-${suffix}`,
      organizationId: orgId,
      installationId: installation.id,
      repo,
    });
    const event: GitEvent = {
      type: "pr_opened",
      installation: "556",
      repo,
      pr: 7,
      sha: "a".repeat(40),
      branch: "feature/x",
    };
    const { post, seen } = setup(event);

    expect((await post()).status).toBe(202);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toEqual(event);
    expect(seen[0]?.context.app).toMatchObject({ id: appRowId, organizationId: orgId });
    expect(seen[0]?.context.projects).toEqual([{ id: `p-${suffix}`, organizationId: orgId }]);
  });

  it("drops an event from an installation it never recorded", async () => {
    const { post, seen } = setup({
      type: "push",
      installation: "unknown",
      repo,
      branch: "main",
      sha: "a".repeat(40),
      deleted: false,
    });
    expect((await post()).status).toBe(202);
    expect(seen).toEqual([]);
  });
});
