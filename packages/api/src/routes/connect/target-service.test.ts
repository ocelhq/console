import { generateKeyPairSync } from "node:crypto";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import { TargetService } from "@console/connectors/gen/console/v1/target_pb";
import { db } from "@console/db";
import { type CredentialGrant, credentialIssuance, targetTier } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { addPipeline } from "@console/git";
import { createIssuer, keySigner } from "@console/targets";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestSessionWithOrganization,
  createTestSessionWithRole,
} from "../../../test/auth-harness";
import { projectIn, serviceClient } from "../../../test/connect-harness";
import { AUDIENCE, githubActions } from "../../pipelines/testing";

const ISSUER = "http://localhost:3000/oidc";
const PROVIDER = "arn:aws:iam::123456789012:oidc-provider/localhost:3000/oidc";
const ROLE = "arn:aws:iam::123456789012:role/ocel-deploy-production";
const GRANTS = ["s3:putobject arn:aws:s3:::ocel-*", "lambda:updatefunctioncode *"];

const issuer = createIssuer("http://localhost:3000", {
  signer: keySigner(
    generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString(),
  ),
  previous: [],
});

let owner: Awaited<ReturnType<typeof createTestSessionWithOrganization>>;
let member: Awaited<ReturnType<typeof createTestSessionWithRole>>;
let stranger: Awaited<ReturnType<typeof createTestSessionWithOrganization>>;
let gha: Awaited<ReturnType<typeof githubActions>>;
let projectId = "";

function client(bearer: string | null, configured = true) {
  return serviceClient(TargetService, bearer, {
    issuer: () => (configured ? Promise.resolve(issuer) : undefined),
    pipelineKeys: { keys: createLocalJWKSet(gha.keys), audience: AUDIENCE },
  });
}

async function refusal(call: Promise<unknown>) {
  return ConnectError.from(
    await call.then(
      () => {
        throw new Error("the call was not refused");
      },
      (thrown: unknown) => thrown,
    ),
  );
}

const place = { vendor: "aws", account: "123456789012", region: "eu-west-1" };

async function bootstrapped(over: { grants?: string[]; bind?: boolean } = {}) {
  const prepared = await client(owner.token).prepare({ ...place, projectId });
  await client(owner.token).recordTier({
    targetId: prepared.targetId,
    tier: Tier.PRODUCTION,
    identity: { identityProvider: PROVIDER, principal: ROLE },
    grants: over.grants ?? GRANTS,
    cliVersion: "0.0.3",
    ...(over.bind === false ? {} : { projectId }),
  });
  return prepared;
}

function trusted(credentials: CredentialGrant = { production: { branches: ["main"] } }) {
  return addPipeline({
    projectId,
    repository: "acme/web",
    repositoryId: "1234",
    repositoryOwnerId: "42",
    workflow: null,
    environment: null,
    branches: ["*"],
    origin: "manual",
    createdBy: null,
    credentials,
  });
}

const issue = (token: string, over: { grants?: string[]; vendor?: string } = {}) =>
  client(token).issueCredential({
    projectId,
    tier: Tier.PRODUCTION,
    vendor: over.vendor ?? "aws",
    grants: over.grants ?? GRANTS.slice(0, 1),
    cliVersion: "0.0.4",
  });

beforeAll(async () => {
  await setupTestDatabase();
  gha = await githubActions();
  owner = await createTestSessionWithOrganization();
  stranger = await createTestSessionWithOrganization();
  member = await createTestSessionWithRole(owner.organization.id, "member");
});

beforeEach(async () => {
  projectId = await projectIn(owner.organization.id, `t-${crypto.randomUUID()}`);
});

afterAll(async () => {
  await member.cleanup();
  await owner.cleanup();
  await stranger.cleanup();
});

describe("preparing a target", () => {
  it("answers what bootstrap writes into the cloud's trust, the same target each time", async () => {
    const prepared = await client(owner.token).prepare({ ...place, projectId });

    expect(prepared).toMatchObject({
      organizationId: owner.organization.id,
      issuer: ISSUER,
      audience: `ocel-target:${prepared.targetId}`,
      subjectPrefix: `org:${owner.organization.id}:target:${prepared.targetId}`,
    });
    expect((await client(owner.token).prepare(place)).targetId).toBe(prepared.targetId);
  });

  it("is refused to a member who is no owner or admin", async () => {
    const error = await refusal(client(member.token).prepare(place));

    expect(error.code).toBe(Code.PermissionDenied);
  });

  it("is refused for another organization's project", async () => {
    const theirs = await projectIn(stranger.organization.id, `s-${crypto.randomUUID()}`);

    const error = await refusal(client(owner.token).prepare({ ...place, projectId: theirs }));

    expect(error.code).toBe(Code.NotFound);
  });

  it("is refused for a vendor the console issues no credentials for", async () => {
    const error = await refusal(client(owner.token).prepare({ ...place, vendor: "azure" }));

    expect(error.code).toBe(Code.InvalidArgument);
    expect(error.rawMessage).toContain("aws or gcp, not azure");
  });

  it("is refused for an account the vendor has no such form of", async () => {
    const error = await refusal(client(owner.token).prepare({ ...place, account: "acme" }));

    expect(error.code).toBe(Code.InvalidArgument);
    expect(error.rawMessage).toContain("12 digits");
  });

  it("is refused, naming what to set, while the console has no issuer key", async () => {
    const error = await refusal(client(owner.token, false).prepare(place));

    expect(error.code).toBe(Code.FailedPrecondition);
    expect(error.rawMessage).toContain("CONSOLE_ISSUER_KEY");
  });
});

describe("recording a tier", () => {
  it("stores the tier's identity and grants and binds the project's tier to the target", async () => {
    const prepared = await bootstrapped();

    const [stored] = await db
      .select()
      .from(targetTier)
      .where(eq(targetTier.targetId, prepared.targetId));
    expect(stored).toMatchObject({
      tier: "production",
      identityProvider: PROVIDER,
      principal: ROLE,
      grants: GRANTS,
      cliVersion: "0.0.3",
    });
  });

  it("lower-cases an AWS grant's action, as the CLI does", async () => {
    const prepared = await bootstrapped({ grants: ["S3:PutObject arn:aws:s3:::Bucket/*"] });

    const [stored] = await db
      .select()
      .from(targetTier)
      .where(eq(targetTier.targetId, prepared.targetId));
    expect(stored?.grants).toEqual(["s3:putobject arn:aws:s3:::Bucket/*"]);
  });

  it.each([
    ["a role in another account", PROVIDER, "arn:aws:iam::999999999999:role/deploy"],
    [
      "a provider for another issuer",
      "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
      ROLE,
    ],
  ])("is refused for %s", async (_, identityProvider, principal) => {
    const prepared = await client(owner.token).prepare(place);

    const error = await refusal(
      client(owner.token).recordTier({
        targetId: prepared.targetId,
        tier: Tier.PRODUCTION,
        identity: { identityProvider, principal },
        grants: GRANTS,
        cliVersion: "0.0.3",
      }),
    );

    expect(error.code).toBe(Code.InvalidArgument);
  });

  it("is refused for another organization's target", async () => {
    const theirs = await client(stranger.token).prepare(place);

    const error = await refusal(
      client(owner.token).recordTier({
        targetId: theirs.targetId,
        tier: Tier.PRODUCTION,
        identity: { identityProvider: PROVIDER, principal: ROLE },
        grants: GRANTS,
        cliVersion: "0.0.3",
      }),
    );

    expect(error.code).toBe(Code.NotFound);
  });
});

describe("issuing a credential", () => {
  it("mints a token for the bound target's tier that the issuer's keys verify, and logs it", async () => {
    const prepared = await bootstrapped();
    const pipeline = await trusted();

    const issued = await issue(await gha.push("main"));

    const { payload } = await jwtVerify(issued.token, createLocalJWKSet(await issuer.jwks()), {
      issuer: ISSUER,
      audience: `ocel-target:${prepared.targetId}`,
      algorithms: ["ES256"],
    });
    const org = owner.organization.id;
    expect(payload).toMatchObject({
      sub: `org:${org}:target:${prepared.targetId}:tier:production:project:${projectId}`,
      org,
      target: prepared.targetId,
      tier: "production",
      project: projectId,
      purpose: "deploy",
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(600);
    expect(payload.nbf).toBe(payload.iat);
    expect(issued).toMatchObject({
      targetId: prepared.targetId,
      account: "123456789012",
      region: "eu-west-1",
      sessionName: `ocel-${String(payload.jti).slice(0, 12)}`,
      identity: { identityProvider: PROVIDER, principal: ROLE },
    });
    expect(issued.expiresAt && timestampDate(issued.expiresAt).getTime()).toBe(
      (payload.exp ?? 0) * 1000,
    );

    const [logged] = await db
      .select()
      .from(credentialIssuance)
      .where(eq(credentialIssuance.tokenJti, String(payload.jti)));
    expect(logged).toMatchObject({
      organizationId: org,
      projectId,
      targetId: prepared.targetId,
      tier: "production",
      purpose: "deploy",
      principal: {
        kind: "pipeline",
        pipelineId: pipeline.id,
        runUrl: "https://github.com/acme/web/actions/runs/9001/attempts/2",
      },
    });
    const [tier] = await db
      .select()
      .from(targetTier)
      .where(eq(targetTier.targetId, prepared.targetId));
    expect(tier?.lastIssuedAt).toBeInstanceOf(Date);
  });

  it("spends the run's token, so a second use is refused", async () => {
    await bootstrapped();
    await trusted();
    const token = await gha.push("main");
    await issue(token);

    expect((await refusal(issue(token))).code).toBe(Code.Unauthenticated);
  });

  it("is refused when no target is bound to the project's tier, leaving the token unspent", async () => {
    const prepared = await bootstrapped({ bind: false });
    await trusted();
    const token = await gha.push("main");

    const error = await refusal(issue(token));

    expect(error.code).toBe(Code.NotFound);
    expect(error.rawMessage).toContain(`No target is bound to ${projectId} production`);
    await client(owner.token).recordTier({
      targetId: prepared.targetId,
      tier: Tier.PRODUCTION,
      identity: { identityProvider: PROVIDER, principal: ROLE },
      grants: GRANTS,
      cliVersion: "0.0.3",
      projectId,
    });
    await expect(issue(token)).resolves.toBeDefined();
  });

  it("is refused for grants the tier was not given, naming them, the version that recorded it and the fix", async () => {
    await bootstrapped();
    await trusted();
    const asked = Array.from({ length: 12 }, (_, n) => `dynamodb:putitem table-${n}`);

    const error = await refusal(
      issue(await gha.push("main"), { grants: [GRANTS[0] ?? "", ...asked] }),
    );

    expect(error.code).toBe(Code.FailedPrecondition);
    expect(error.rawMessage).toContain("dynamodb:putitem table-9");
    expect(error.rawMessage).not.toContain("dynamodb:putitem table-10");
    expect(error.rawMessage).toContain("and 2 more");
    expect(error.rawMessage).toContain("0.0.3");
    expect(error.rawMessage).toContain("an admin runs `ocel bootstrap production`");
  });

  it("is refused for a vendor other than the bound target's", async () => {
    await bootstrapped();
    await trusted();

    const error = await refusal(issue(await gha.push("main"), { vendor: "gcp" }));

    expect(error.code).toBe(Code.FailedPrecondition);
    expect(error.rawMessage).toContain("aws");
  });

  it("is refused to a run the pipeline's credential grant does not cover", async () => {
    await bootstrapped();
    await trusted({ preview: { branches: ["*"] } });

    const error = await refusal(issue(await gha.push("main")));

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain("no production credential grant");
  });

  it("is refused to a session", async () => {
    await bootstrapped();

    const error = await refusal(issue(owner.token));

    expect(error.code).toBe(Code.PermissionDenied);
  });
});
