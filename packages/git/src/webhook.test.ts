import { createHmac, randomBytes } from "node:crypto";
import { db } from "@console/db";
import { gitApp, organization, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { pg } from "@console/infra";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { delivery } from "./github/test-support";
import { envKeyStore, type KeyStore } from "./keystore";
import type { GitEvent } from "./provider";
import { gitRuntime } from "./runtime";
import { gitStore } from "./store";
import { type GitEventContext, webhookHandler } from "./webhook";

const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`;
const appRowId = `app-${suffix}`;
const webhookSecret = "whsec_handler";
const unwrapped: string[] = [];
const envKeys = envKeyStore(randomBytes(32).toString("base64"));
const keys: KeyStore = {
  wrap: envKeys.wrap,
  async unwrap(key, context) {
    unwrapped.push(context);
    return envKeys.unwrap(key, context);
  },
};
const store = gitStore(keys);

const installation = { id: 556 };
const repository = { id: 1234, full_name: "acme/web" };

function setup(failWith?: Error) {
  const seen: { event: GitEvent; context: GitEventContext }[] = [];
  const handler = webhookHandler({
    ...gitRuntime(keys),
    onEvent: async (event, context) => {
      if (failWith) throw failWith;
      seen.push({ event, context });
    },
  });
  return { seen, post: handler };
}

function pullRequestOpened(secret = webhookSecret) {
  return delivery(
    "pull_request",
    {
      action: "opened",
      number: 7,
      installation,
      repository,
      pull_request: { head: { sha: "a".repeat(40), ref: "feature/x", repo: { id: 1234 } } },
    },
    secret,
  );
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
    webhookSecret,
    clientId: "c",
    clientSecret: "cs",
  });
  const bound = await store.bindInstallation({
    gitAppId: appRowId,
    organizationId: orgId,
    externalId: String(installation.id),
    account: "acme",
  });
  if (bound === "claimed") throw new Error("claimed");
  await db
    .insert(project)
    .values({ id: `p-${suffix}`, organizationId: orgId, name: "P", slug: "p" });
  await store.linkProjectRepo({
    projectId: `p-${suffix}`,
    organizationId: orgId,
    installationId: bound.id,
    repo: { id: "1234", fullName: "acme/web" },
  });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
  await db.delete(gitApp).where(eq(gitApp.id, appRowId));
  await pg.end();
});

describe("webhookHandler", () => {
  it("answers 404 for an app it does not hold", async () => {
    const { post } = setup();
    expect((await post(pullRequestOpened(), "unknown")).status).toBe(404);
  });

  it("refuses a forged delivery having opened only the webhook secret", async () => {
    const { post, seen } = setup();
    unwrapped.length = 0;
    expect((await post(pullRequestOpened("forged"), appRowId)).status).toBe(401);
    expect(seen).toEqual([]);
    expect(unwrapped).toEqual([`git_app/${appRowId}/webhook_secret`]);
  });

  it.each([
    ["an empty body", ""],
    ["a body that is not JSON", "not json"],
  ])("answers 400 to a signed delivery with %s", async (_, body) => {
    const { post } = setup();
    const request = delivery("push", {}, webhookSecret);
    request.headers.set(
      "x-hub-signature-256",
      `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
    );
    expect((await post({ ...request, body }, appRowId)).status).toBe(400);
  });

  it("answers 400 to a delivery with no delivery id", async () => {
    const { post } = setup();
    const request = pullRequestOpened();
    request.headers.delete("x-github-delivery");
    expect((await post(request, appRowId)).status).toBe(400);
  });

  it("accepts and ignores an event it has no use for", async () => {
    const { post, seen } = setup();
    expect((await post(delivery("star", {}, webhookSecret), appRowId)).status).toBe(202);
    expect(seen).toEqual([]);
  });

  it("tells the handler which projects build from the repo an event is about", async () => {
    const { post, seen } = setup();

    expect((await post(pullRequestOpened(), appRowId)).status).toBe(202);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toMatchObject({ type: "pr_opened", pr: 7, installation: "556" });
    expect(seen[0]?.context.app).toMatchObject({ id: appRowId, organizationId: orgId });
    expect(seen[0]?.context.installation).toMatchObject({ organizationId: orgId });
    expect(seen[0]?.context.projects).toEqual([{ id: `p-${suffix}`, organizationId: orgId }]);
  });

  it("acts on a delivery once, however often it arrives", async () => {
    const { post, seen } = setup();
    const request = pullRequestOpened();

    expect((await post(request, appRowId)).status).toBe(202);
    expect((await post(request, appRowId)).status).toBe(202);

    expect(seen).toHaveLength(1);
  });

  it("takes a delivery again when acting on it failed, so GitHub's redelivery works", async () => {
    const request = pullRequestOpened();
    await expect(setup(new Error("boom")).post(request, appRowId)).rejects.toThrow("boom");

    const { post, seen } = setup();
    expect((await post(request, appRowId)).status).toBe(202);
    expect(seen).toHaveLength(1);
  });

  it("drops an event from an installation no organization bound", async () => {
    const { post, seen } = setup();
    const request = delivery(
      "push",
      {
        ref: "refs/heads/main",
        after: "a".repeat(40),
        installation: { id: 999 },
        repository,
      },
      webhookSecret,
    );
    expect((await post(request, appRowId)).status).toBe(202);
    expect(seen).toEqual([]);
  });

  it("forgets an installation that was removed", async () => {
    const { post } = setup();
    const request = delivery(
      "installation",
      { action: "deleted", installation: { id: 556, account: { login: "acme" } } },
      webhookSecret,
    );
    expect((await post(request, appRowId)).status).toBe(202);
    expect(await store.findInstallation(appRowId, "556")).toBeUndefined();
  });
});
