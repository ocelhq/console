import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { db } from "@console/db";
import { organization } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { envKeyStore, gitRuntime } from "@console/git";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubWebhooks } from "./route";

const suffix = crypto.randomUUID();
const appId = `app-${suffix}`;
const orgId = `org-${suffix}`;
const webhookSecret = "whsec_route";
const git = gitRuntime(envKeyStore(randomBytes(32).toString("base64")));

function delivery(
  secret: string,
  event = "ping",
  payload: unknown = { zen: "Keep it logically awesome." },
) {
  const body = JSON.stringify(payload);
  return new Request(`http://localhost/api/git/github/${appId}/webhooks`, {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  await db
    .insert(organization)
    .values({ id: orgId, name: "Org", slug: orgId, createdAt: new Date() });
  await git.store.createOrganizationApp({
    id: appId,
    organizationId: orgId,
    kind: "github",
    appId: `gh-${appId}`,
    slug: "route-test",
    privateKey: generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey,
    webhookSecret,
    clientId: "Iv1.route",
    clientSecret: "secret",
  });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
});

describe("POST /api/git/github/:appId/webhooks", () => {
  it("accepts a delivery signed with the app's secret", async () => {
    const response = await githubWebhooks(delivery(webhookSecret), appId, git);
    expect(response.status).toBe(202);
  });

  it("refuses a delivery signed with another secret", async () => {
    const response = await githubWebhooks(delivery("forged"), appId, git);
    expect(response.status).toBe(401);
  });

  it("answers 503 when the console has no git integrations", async () => {
    const response = await githubWebhooks(delivery(webhookSecret), appId, undefined);
    expect(response.status).toBe(503);
  });

  it("answers 404 for an app the console does not hold", async () => {
    const response = await githubWebhooks(delivery(webhookSecret), "nope", git);
    expect(response.status).toBe(404);
  });
});
