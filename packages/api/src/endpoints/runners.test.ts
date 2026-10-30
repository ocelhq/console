import { Code, ConnectError } from "@connectrpc/connect";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import { Scope } from "@console/connectors/gen/common/scope/v1/scope_pb";
import { EndpointReach, EndpointService } from "@console/connectors/gen/console/v1/endpoint_pb";
import { RunnerService } from "@console/connectors/gen/runner/v1/runner_pb";
import { db } from "@console/db";
import { deployment, endpoint, runnerBinding } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTestSessionWithOrganization,
  createTestSessionWithRole,
} from "../../test/auth-harness";
import { projectIn, serviceClient } from "../../test/connect-harness";

const offered = vi.hoisted(() => ({
  offer: undefined as
    | { apiUrl: string; providerUrl: string; audience: string; version: string }
    | undefined,
}));

vi.mock("../../../endpoints/src/offer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../endpoints/src/offer")>()),
  readCloudOffer: () => offered.offer,
}));

afterEach(() => {
  offered.offer = undefined;
});

const cloudOffer = {
  apiUrl: "https://cloud.example.test/api",
  providerUrl: "https://provider.cloud.example.test",
  audience: "ocel-cloud",
  version: "0.0.9",
};

function endpoints(bearer: string | null) {
  return serviceClient(EndpointService, bearer);
}

async function refusalOf(call: Promise<unknown>): Promise<ConnectError> {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  return ConnectError.from(error);
}

async function codeOf(call: Promise<unknown>): Promise<Code> {
  return (await refusalOf(call)).code;
}

function slug(): string {
  return `p-${crypto.randomUUID().slice(0, 8)}`;
}

async function runnerOf(
  bearer: string,
  allowedScopes: readonly string[] = ["apps.read", "apps.write"],
): Promise<string> {
  const { endpoint: saved } = await endpoints(bearer).upsert({
    name: `runner-${crypto.randomUUID().slice(0, 8)}`,
    vendor: "vps",
    reach: EndpointReach.DIAL,
  });
  const id = saved?.id ?? "";
  await db
    .update(endpoint)
    .set({
      url: "https://runner.example.com",
      services: [RunnerService.typeName],
      allowedScopes: [...allowedScopes],
    })
    .where(eq(endpoint.id, id));
  return id;
}

async function bindingOf(projectId: string, tier: "production" | "preview") {
  const [found] = await db
    .select()
    .from(runnerBinding)
    .where(and(eq(runnerBinding.projectId, projectId), eq(runnerBinding.tier, tier)));
  return found;
}

async function deployedTo(
  projectId: string,
  tier: "production" | "preview",
  provider: string,
  outcomeBy: "ocel" | "console" = "ocel",
) {
  await db.insert(deployment).values({
    id: crypto.randomUUID(),
    projectId,
    deploymentId: crypto.randomUUID().replaceAll("-", ""),
    kind: "deploy",
    tier,
    providerName: provider,
    target:
      provider === "ocel" ? "ocel/cloud" : provider === "" ? "" : "aws/123456789012/us-east-1/main",
    outcome: outcomeBy === "ocel" ? "succeeded" : "canceled",
    outcomeBy,
    trigger: { kind: "cli" },
    deployedAt: new Date(),
  });
}

beforeAll(async () => {
  await setupTestDatabase();
});

describe("removing a runner", () => {
  it("drops every binding to it", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const runner = await runnerOf(session.token);
      const projectId = await projectIn(session.organization.id, slug());
      await endpoints(session.token).bindRunner({
        projectId,
        tier: Tier.PRODUCTION,
        runnerId: runner,
        credentials: true,
      });

      await endpoints(session.token).remove({ id: runner });

      expect(await bindingOf(projectId, "production")).toBeUndefined();
    } finally {
      await session.cleanup();
    }
  });
});

describe("BindRunner", () => {
  it("binds an endpoint that serves runner.v1.RunnerService, with or without credentials", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const runner = await runnerOf(session.token);
      const projectId = await projectIn(session.organization.id, slug());
      const client = endpoints(session.token);

      await client.bindRunner({
        projectId,
        tier: Tier.PREVIEW,
        runnerId: runner,
        credentials: true,
      });
      expect(await bindingOf(projectId, "preview")).toMatchObject({
        runner: "endpoint",
        endpointId: runner,
        credentials: true,
      });

      await client.bindRunner({
        projectId,
        tier: Tier.PREVIEW,
        runnerId: runner,
        credentials: false,
      });
      expect(await bindingOf(projectId, "preview")).toMatchObject({ credentials: false });
    } finally {
      await session.cleanup();
    }
  });

  it("returns FailedPrecondition for an endpoint that serves no runner", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const { endpoint: saved } = await endpoints(session.token).upsert({
        name: "box",
        vendor: "vps",
        reach: EndpointReach.DIAL,
      });
      const projectId = await projectIn(session.organization.id, slug());
      expect(
        await codeOf(
          endpoints(session.token).bindRunner({
            projectId,
            tier: Tier.PRODUCTION,
            runnerId: saved?.id ?? "",
          }),
        ),
      ).toBe(Code.FailedPrecondition);
      expect(await bindingOf(projectId, "production")).toBeUndefined();
    } finally {
      await session.cleanup();
    }
  });

  it("returns FailedPrecondition for a runner that does not let the console follow and cancel its jobs", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const runner = await runnerOf(session.token, ["apps.read"]);
      const projectId = await projectIn(session.organization.id, slug());

      const refused = await refusalOf(
        endpoints(session.token).bindRunner({ projectId, tier: Tier.PRODUCTION, runnerId: runner }),
      );

      expect(refused.code).toBe(Code.FailedPrecondition);
      expect(refused.rawMessage).toContain("CancelJob");
      expect(await bindingOf(projectId, "production")).toBeUndefined();
    } finally {
      await session.cleanup();
    }
  });

  it("returns NotFound for another organization's runner or project", async () => {
    const session = await createTestSessionWithOrganization();
    const other = await createTestSessionWithOrganization();
    try {
      const theirs = await runnerOf(other.token);
      const ours = await runnerOf(session.token);
      const projectId = await projectIn(session.organization.id, slug());
      const theirProject = await projectIn(other.organization.id, slug());
      const client = endpoints(session.token);
      expect(
        await codeOf(client.bindRunner({ projectId, tier: Tier.PRODUCTION, runnerId: theirs })),
      ).toBe(Code.NotFound);
      expect(
        await codeOf(
          client.bindRunner({ projectId: theirProject, tier: Tier.PRODUCTION, runnerId: ours }),
        ),
      ).toBe(Code.NotFound);
    } finally {
      await session.cleanup();
      await other.cleanup();
    }
  });

  it("returns PermissionDenied for a plain member", async () => {
    const session = await createTestSessionWithOrganization();
    const plain = await createTestSessionWithRole(session.organization.id, "member");
    try {
      const runner = await runnerOf(session.token);
      const projectId = await projectIn(session.organization.id, slug());
      expect(
        await codeOf(
          endpoints(plain.token).bindRunner({ projectId, tier: Tier.PRODUCTION, runnerId: runner }),
        ),
      ).toBe(Code.PermissionDenied);
    } finally {
      await plain.cleanup();
      await session.cleanup();
    }
  });

  it("binds Ocel Cloud's runner only while the console offers it", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, slug());
      const bind = () =>
        endpoints(session.token).bindRunner({
          projectId,
          tier: Tier.PRODUCTION,
          runnerId: "ocel-cloud",
          credentials: true,
        });

      expect(await codeOf(bind())).toBe(Code.FailedPrecondition);

      offered.offer = cloudOffer;
      await bind();
      expect(await bindingOf(projectId, "production")).toMatchObject({
        runner: "ocel-cloud",
        endpointId: null,
      });
    } finally {
      await session.cleanup();
    }
  });

  it("refuses any runner but Ocel Cloud's for a tier that deploys to Ocel Cloud, whatever the console ended since", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const runner = await runnerOf(session.token);
      const projectId = await projectIn(session.organization.id, slug());
      await deployedTo(projectId, "production", "ocel");
      await deployedTo(projectId, "production", "", "console");

      expect(
        await codeOf(
          endpoints(session.token).bindRunner({
            projectId,
            tier: Tier.PRODUCTION,
            runnerId: runner,
          }),
        ),
      ).toBe(Code.FailedPrecondition);
    } finally {
      await session.cleanup();
    }
  });
});

describe("UnbindRunner", () => {
  it("removes the binding, for an admin only", async () => {
    const session = await createTestSessionWithOrganization();
    const plain = await createTestSessionWithRole(session.organization.id, "member");
    try {
      const runner = await runnerOf(session.token);
      const projectId = await projectIn(session.organization.id, slug());
      await endpoints(session.token).bindRunner({
        projectId,
        tier: Tier.PRODUCTION,
        runnerId: runner,
      });

      expect(
        await codeOf(endpoints(plain.token).unbindRunner({ projectId, tier: Tier.PRODUCTION })),
      ).toBe(Code.PermissionDenied);
      await endpoints(session.token).unbindRunner({ projectId, tier: Tier.PRODUCTION });

      expect(await bindingOf(projectId, "production")).toBeUndefined();
    } finally {
      await plain.cleanup();
      await session.cleanup();
    }
  });
});

describe("ResolveRunner", () => {
  it("answers the bound runner and whether its jobs get credentials, to a plain member", async () => {
    const session = await createTestSessionWithOrganization();
    const plain = await createTestSessionWithRole(session.organization.id, "member");
    try {
      const runner = await runnerOf(session.token);
      const projectId = await projectIn(session.organization.id, slug());
      await endpoints(session.token).bindRunner({
        projectId,
        tier: Tier.PRODUCTION,
        runnerId: runner,
        credentials: true,
      });

      const resolved = await endpoints(plain.token).resolveRunner({
        projectId,
        tier: Tier.PRODUCTION,
        provider: "aws",
      });

      expect(resolved.runner).toMatchObject({ id: runner, url: "https://runner.example.com" });
      expect(resolved.credentials).toBe(true);
    } finally {
      await plain.cleanup();
      await session.cleanup();
    }
  });

  it("answers Ocel Cloud's runner for a project that names no provider and binds none", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      offered.offer = cloudOffer;
      const projectId = await projectIn(session.organization.id, slug());

      const { runner: resolved } = await endpoints(session.token).resolveRunner({
        projectId,
        tier: Tier.PRODUCTION,
        provider: "",
      });

      expect(resolved).toMatchObject({
        id: "ocel-cloud",
        name: "ocel-cloud",
        target: "ocel/cloud",
        url: cloudOffer.apiUrl,
        version: cloudOffer.version,
        online: true,
        allowedScopes: [
          Scope.APPS_READ,
          Scope.APPS_WRITE,
          Scope.VARIABLES_READ,
          Scope.VARIABLES_WRITE,
          Scope.VARIABLES_REVEAL,
        ],
      });
      expect(resolved?.services).toContain(RunnerService.typeName);
    } finally {
      await session.cleanup();
    }
  });

  it("refuses, as dispatch would, a project that names no provider whose tier is bound to another runner", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      offered.offer = cloudOffer;
      const runner = await runnerOf(session.token);
      const projectId = await projectIn(session.organization.id, slug());
      await endpoints(session.token).bindRunner({
        projectId,
        tier: Tier.PRODUCTION,
        runnerId: runner,
      });

      const refused = await refusalOf(
        endpoints(session.token).resolveRunner({
          projectId,
          tier: Tier.PRODUCTION,
          provider: "",
        }),
      );

      expect(refused.code).toBe(Code.FailedPrecondition);
      expect(refused.rawMessage).toContain("only on Ocel Cloud's runner");
    } finally {
      await session.cleanup();
    }
  });

  it("never guesses Ocel Cloud for a project that names a provider and has no binding", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      offered.offer = cloudOffer;
      const projectId = await projectIn(session.organization.id, slug());
      const refused = await refusalOf(
        endpoints(session.token).resolveRunner({ projectId, tier: Tier.PREVIEW, provider: "aws" }),
      );
      expect(refused.code).toBe(Code.FailedPrecondition);
      expect(refused.rawMessage).toContain("bind a runner to preview");
    } finally {
      await session.cleanup();
    }
  });

  it("returns FailedPrecondition for a project that names no provider when the console offers no Ocel Cloud", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, slug());
      expect(
        await codeOf(
          endpoints(session.token).resolveRunner({
            projectId,
            tier: Tier.PRODUCTION,
            provider: "",
          }),
        ),
      ).toBe(Code.FailedPrecondition);
    } finally {
      await session.cleanup();
    }
  });

  it("returns NotFound for another organization's project", async () => {
    const session = await createTestSessionWithOrganization();
    const other = await createTestSessionWithOrganization();
    try {
      const theirs = await projectIn(other.organization.id, slug());
      expect(
        await codeOf(
          endpoints(session.token).resolveRunner({
            projectId: theirs,
            tier: Tier.PRODUCTION,
            provider: "aws",
          }),
        ),
      ).toBe(Code.NotFound);
    } finally {
      await session.cleanup();
      await other.cleanup();
    }
  });
});
