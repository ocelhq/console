import { generateKeyPairSync } from "node:crypto";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { auth } from "@console/auth";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import { TargetService } from "@console/connectors/gen/console/v1/target_pb";
import { db } from "@console/db";
import {
  type CredentialGrant,
  credentialIssuance,
  type JobKind,
  type JobStatus,
  job,
  targetBinding,
  targetTier,
} from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { addPipeline } from "@console/git";
import { createIssuer, keySigner } from "@console/targets";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestSessionWithOrganization,
  createTestSessionWithRole,
} from "../../../test/auth-harness";
import { bindRunnerRow, projectIn, serviceClient } from "../../../test/connect-harness";
import { AUDIENCE, githubActions } from "../../pipelines/testing";

const ISSUER = "http://localhost:3000/oidc";
const PROVIDER = "arn:aws:iam::123456789012:oidc-provider/localhost:3000/oidc";
const ROLE = "arn:aws:iam::123456789012:role/ocel-deploy-production";

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

const place = { vendor: "aws", account: "123456789012", region: "eu-west-1", namespace: "ocel" };
const box = { vendor: "vps", account: "box.example.com", region: "" };
const BOX_ENDPOINT = "https://box.example.com";

async function bootstrapped(over: { bind?: boolean; vps?: boolean } = {}) {
  const prepared = await client(owner.token).prepare({ ...(over.vps ? box : place), projectId });
  await client(owner.token).recordTier({
    targetId: prepared.targetId,
    tier: Tier.PRODUCTION,
    identity: over.vps
      ? { identityProvider: BOX_ENDPOINT, principal: "" }
      : { identityProvider: PROVIDER, principal: ROLE },
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

const issue = (token: string, over: { vendor?: string } = {}) =>
  client(token).issueCredential({
    projectId,
    tier: Tier.PRODUCTION,
    vendor: over.vendor ?? "aws",
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
    });
    expect((await client(owner.token).prepare(place)).targetId).toBe(prepared.targetId);
  });

  it("prepares a target per namespace in one account and region", async () => {
    const ocel = await client(owner.token).prepare({ ...place, region: "eu-west-3" });
    const staging = await client(owner.token).prepare({
      ...place,
      region: "eu-west-3",
      namespace: "staging",
    });

    expect(staging.targetId).not.toBe(ocel.targetId);
  });

  it("refuses a namespace bootstrap could not name resources with", async () => {
    const error = await refusal(
      client(owner.token).prepare({ ...place, namespace: "Not_A-Namespace" }),
    );

    expect(error.code).toBe(Code.InvalidArgument);
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
    expect(error.rawMessage).toContain("aws, gcp or vps, not azure");
  });

  it("is refused for an account the vendor has no such form of", async () => {
    const error = await refusal(client(owner.token).prepare({ ...place, account: "acme" }));

    expect(error.code).toBe(Code.InvalidArgument);
    expect(error.rawMessage).toContain("12 digits");
  });

  it("is refused for a region the vendor has none of, or lacking one it needs", async () => {
    const regionless = await refusal(client(owner.token).prepare({ ...place, region: "" }));
    expect(regionless.code).toBe(Code.InvalidArgument);
    expect(regionless.rawMessage).toContain("needs a region");

    const boxed = await refusal(client(owner.token).prepare({ ...box, region: "eu-west-1" }));
    expect(boxed.code).toBe(Code.InvalidArgument);
    expect(boxed.rawMessage).toContain("has no region");
  });

  it("is refused for a VPS box named by its IP address", async () => {
    const error = await refusal(client(owner.token).prepare({ ...box, account: "192.0.2.10" }));

    expect(error.code).toBe(Code.InvalidArgument);
    expect(error.rawMessage).toContain("not an IP address");
  });

  it("is refused, naming what to set, while the console has no issuer key", async () => {
    const error = await refusal(client(owner.token, false).prepare(place));

    expect(error.code).toBe(Code.FailedPrecondition);
    expect(error.rawMessage).toContain("CONSOLE_ISSUER_KEY");
  });
});

describe("recording a tier", () => {
  it("stores the tier's identity and binds the project's tier to the target", async () => {
    const prepared = await bootstrapped();

    const [stored] = await db
      .select()
      .from(targetTier)
      .where(eq(targetTier.targetId, prepared.targetId));
    expect(stored).toMatchObject({
      tier: "production",
      identityProvider: PROVIDER,
      principal: ROLE,
      cliVersion: "0.0.3",
    });
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
      namespace: "ocel",
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
      cliVersion: "0.0.3",
      projectId,
    });
    await expect(issue(token)).resolves.toBeDefined();
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

  it("is refused, naming the fix, once an admin forgot the tier's identity", async () => {
    const prepared = await bootstrapped();
    await trusted();
    await client(owner.token).forgetTier({ targetId: prepared.targetId, tier: Tier.PRODUCTION });

    const error = await refusal(issue(await gha.push("main")));

    expect(error.code).toBe(Code.FailedPrecondition);
    expect(error.rawMessage).toContain(
      `The production deploy identity of target ${prepared.targetId}`,
    );
    expect(error.rawMessage).toContain("was removed: an admin runs `ocel bootstrap production`");
  });

  it("is refused to a session", async () => {
    await bootstrapped();

    const error = await refusal(issue(owner.token));

    expect(error.code).toBe(Code.PermissionDenied);
  });
});

const RUNNER = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

async function dispatched(
  over: { kind?: JobKind; status?: JobStatus; runner?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(job).values({
    id,
    projectId,
    kind: over.kind ?? "deploy",
    tier: "production",
    status: over.status ?? "running",
    dedupeKey: id,
    eventAt: new Date(),
    runnerId: over.runner ?? RUNNER,
  });
  return id;
}

async function boundRunner(credentials: boolean, runnerId = RUNNER) {
  await bindRunnerRow(projectId, "production", runnerId, credentials);
}

async function jobToken(
  jobId: string,
  over: { runner?: string; tier?: string; project?: string; audience?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        iss: "http://localhost:3000",
        aud: over.audience ?? "ocel-job",
        sub: `org:${owner.organization.id}:tier:${over.tier ?? "production"}:project:${over.project ?? projectId}`,
        job_id: jobId,
        runner: over.runner ?? RUNNER,
        slug: "web",
        jti: crypto.randomUUID(),
        iat: now,
        exp: now + 600,
      },
    },
  });
  return token;
}

describe("issuing a credential to a job", () => {
  it("mints for a job on the tier's bound runner with credentials, logs the job, and never spends its token", async () => {
    const prepared = await bootstrapped();
    await boundRunner(true);
    const jobId = await dispatched();
    const token = await jobToken(jobId);

    const issued = await issue(token);
    await expect(issue(token)).resolves.toBeDefined();

    const { payload } = await jwtVerify(issued.token, createLocalJWKSet(await issuer.jwks()), {
      issuer: ISSUER,
      audience: `ocel-target:${prepared.targetId}`,
    });
    expect(payload).toMatchObject({ project: projectId, tier: "production", purpose: "deploy" });
    const [logged] = await db
      .select()
      .from(credentialIssuance)
      .where(eq(credentialIssuance.tokenJti, String(payload.jti)));
    expect(logged?.principal).toEqual({ kind: "job", jobId, runner: RUNNER });
  });

  it("is refused, naming the fix, while the tier's runner is bound without credentials", async () => {
    await bootstrapped();
    await boundRunner(false);

    const error = await refusal(issue(await jobToken(await dispatched())));

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain("with credentials");
  });

  it("is refused to a job on a runner other than the tier's bound one", async () => {
    await bootstrapped();
    await boundRunner(true, "ocel-cloud");

    const error = await refusal(issue(await jobToken(await dispatched())));

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain("not the runner bound to production");
  });

  it("is refused to a build, which deploys nothing", async () => {
    await bootstrapped();
    await boundRunner(true);

    const error = await refusal(issue(await jobToken(await dispatched({ kind: "build" }))));

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain("build");
  });

  it("is refused to a job that has ended", async () => {
    await bootstrapped();
    await boundRunner(true);

    const error = await refusal(issue(await jobToken(await dispatched({ status: "done" }))));

    expect(error.code).toBe(Code.PermissionDenied);
    expect(error.rawMessage).toContain("has ended");
  });

  it("is refused to a job token for another tier or project", async () => {
    await bootstrapped();
    await boundRunner(true);
    const jobId = await dispatched();

    for (const token of [
      await jobToken(jobId, { tier: "preview" }),
      await jobToken(jobId, { project: crypto.randomUUID() }),
    ]) {
      expect((await refusal(issue(token))).code).toBe(Code.PermissionDenied);
    }
  });

  it("is refused to a job token this console did not sign", async () => {
    await bootstrapped();
    await boundRunner(true);
    const jobId = await dispatched();
    const { privateKey } = generateKeyPairSync("ed25519");
    const forged = await new SignJWT({ job_id: jobId, runner: RUNNER, slug: "web" })
      .setProtectedHeader({ alg: "EdDSA", kid: "forged" })
      .setIssuer("http://localhost:3000")
      .setAudience("ocel-job")
      .setSubject(`org:${owner.organization.id}:tier:production:project:${projectId}`)
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);

    expect((await refusal(issue(forged))).code).toBe(Code.Unauthenticated);
  });

  it("answers a VPS box's endpoint as the identity, with no region, no principal and the empty namespace of a target prepared without one", async () => {
    const prepared = await bootstrapped({ vps: true });
    await boundRunner(true);

    const issued = await client(await jobToken(await dispatched())).issueCredential({
      projectId,
      tier: Tier.PRODUCTION,
      vendor: "vps",
      cliVersion: "0.0.4",
    });

    expect(issued).toMatchObject({
      targetId: prepared.targetId,
      account: "box.example.com",
      region: "",
      namespace: "",
      identity: { identityProvider: BOX_ENDPOINT, principal: "" },
    });
  });
});

describe("recording a VPS tier", () => {
  it("is refused for an endpoint on another host than the box", async () => {
    const prepared = await client(owner.token).prepare({ ...box, projectId });

    const error = await refusal(
      client(owner.token).recordTier({
        targetId: prepared.targetId,
        tier: Tier.PRODUCTION,
        identity: { identityProvider: "https://other.example.com", principal: "" },
        cliVersion: "0.0.3",
        projectId,
      }),
    );

    expect(error.code).toBe(Code.InvalidArgument);
  });
});

describe("forgetting a tier", () => {
  it("drops the tier's identity, keeps the project bound, and can be asked again", async () => {
    const prepared = await bootstrapped();
    const forget = () =>
      client(owner.token).forgetTier({ targetId: prepared.targetId, tier: Tier.PRODUCTION });

    await forget();
    await forget();

    expect(
      await db.select().from(targetTier).where(eq(targetTier.targetId, prepared.targetId)),
    ).toEqual([]);
    expect(
      await db.select().from(targetBinding).where(eq(targetBinding.projectId, projectId)),
    ).toMatchObject([{ tier: "production", targetId: prepared.targetId }]);
  });

  it("is refused to a member who is no owner or admin", async () => {
    const prepared = await bootstrapped();

    const error = await refusal(
      client(member.token).forgetTier({ targetId: prepared.targetId, tier: Tier.PRODUCTION }),
    );

    expect(error.code).toBe(Code.PermissionDenied);
    expect(
      await db.select().from(targetTier).where(eq(targetTier.targetId, prepared.targetId)),
    ).toHaveLength(1);
  });

  it("is refused for another organization's target", async () => {
    const theirs = await client(stranger.token).prepare(place);
    await client(stranger.token).recordTier({
      targetId: theirs.targetId,
      tier: Tier.PRODUCTION,
      identity: { identityProvider: PROVIDER, principal: ROLE },
      cliVersion: "0.0.3",
    });

    const error = await refusal(
      client(owner.token).forgetTier({ targetId: theirs.targetId, tier: Tier.PRODUCTION }),
    );

    expect(error.code).toBe(Code.NotFound);
    expect(
      await db.select().from(targetTier).where(eq(targetTier.targetId, theirs.targetId)),
    ).toHaveLength(1);
  });
});
