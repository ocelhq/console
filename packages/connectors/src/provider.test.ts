import { createServer, type Server } from "node:http";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it } from "vitest";
import { Tier } from "./gen/common/environment/v1/environment_pb";
import {
  type GetProjectRequest,
  type GetProjectResponseSchema,
  ProviderService,
  RefusalCode,
  RefusalSchema,
  type RollbackRequest,
} from "./gen/provider/contract/v1/contract_pb";
import { rollback } from "./provider";
import type { Endpoint } from "./transport";

const servers: Server[] = [];
const asked: Tier[][] = [];

afterEach(() => {
  asked.length = 0;
  for (const server of servers.splice(0)) server.close();
});

function serving(
  rollingBack: (request: RollbackRequest, headers: Headers) => AsyncIterable<unknown>,
  project?: (request: GetProjectRequest) => MessageInitShape<typeof GetProjectResponseSchema>,
): Promise<string> {
  const server = createServer(
    connectNodeAdapter({
      routes: (router) =>
        router.service(ProviderService, {
          // biome-ignore lint/suspicious/noExplicitAny: the test streams plain event shapes
          rollback: (request, context) => rollingBack(request, context.requestHeader) as any,
          getProject: (request) => {
            if (!project) throw new ConnectError("no project record", Code.NotFound);
            asked.push(request.tiers);
            if (request.tiers.length === 0) {
              throw new ConnectError("a project read names its tiers", Code.InvalidArgument);
            }
            return project(request);
          },
        }),
    }),
  );
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "");
    });
  });
}

function connector(url: string): Endpoint {
  return { url, controlUrl: url, authorize: async () => "t" };
}

describe("rollback", () => {
  it("rolls the slug's production back to the promotion, and answers the promotion it made", async () => {
    const seen: { to: string; slug: string; tier: string }[] = [];
    const url = await serving(async function* (request, headers) {
      seen.push({
        to: request.to,
        slug: headers.get("Ocel-Slug") ?? "",
        tier: headers.get("Ocel-Tier") ?? "",
      });
      yield { message: "promoting" };
      yield {
        body: {
          case: "result",
          value: {
            success: true,
            promotionId: "prm-new",
            apps: [{ app: "web", release: "rel-1" }],
          },
        },
      };
    });

    const answer = await rollback(connector(url), "shop", "prm-old", null);

    expect(seen).toEqual([{ to: "prm-old", slug: "shop", tier: "production" }]);
    expect(answer).toEqual({
      done: true,
      result: { promotionId: "prm-new", releases: { web: "rel-1" } },
    });
  });

  it("rolls back on the edge and registry the provider recorded for the project", async () => {
    const seen: RollbackRequest[] = [];
    const url = await serving(
      async function* (request) {
        seen.push(request);
        yield { body: { case: "result", value: { success: true, promotionId: "p", apps: [] } } };
      },
      () => ({
        edge: { kind: "cloudflare", dns: { kind: "cloudflare", zone: "example.com" } },
        registry: { server: "registry.example.com", namespace: "shop" },
      }),
    );

    await rollback(connector(url), "shop", "prm-old", "cloudfront");

    expect(asked).toEqual([[Tier.PRODUCTION]]);
    expect(seen[0]?.edge).toMatchObject({ kind: "cloudflare", dns: { zone: "example.com" } });
    expect(seen[0]?.projectRegistry).toMatchObject({ server: "registry.example.com" });
  });

  it("rolls back on the edge the deployment recorded when the provider has no project record", async () => {
    const seen: RollbackRequest[] = [];
    const url = await serving(async function* (request) {
      seen.push(request);
      yield { body: { case: "result", value: { success: true, promotionId: "p", apps: [] } } };
    });

    await rollback(connector(url), "shop", "prm-old", "api-gateway");

    expect(seen[0]?.edge?.kind).toBe("api-gateway");
    expect(seen[0]?.projectRegistry).toBeUndefined();
  });

  it("refuses as needing a runner what an endpoint with no engine refused so", async () => {
    const url = await serving(async function* () {
      yield* [];
      throw new ConnectError("needs a runner", Code.FailedPrecondition, undefined, [
        { desc: RefusalSchema, value: { code: RefusalCode.NEEDS_RUNNER } },
      ]);
    });

    const answer = await rollback(connector(url), "shop", "prm-old", null);

    expect(answer.done === false && answer.refusal.reason).toBe("needs-runner");
  });

  it("fails a rollback whose result says it failed, or that ends with none", async () => {
    const failing = await serving(async function* () {
      yield { body: { case: "result", value: { success: false, error: "the router refused" } } };
    });
    const silent = await serving(async function* () {
      yield { message: "nothing more" };
    });

    expect(await rollback(connector(failing), "shop", "prm-old", null)).toEqual({
      done: false,
      refusal: { reason: "failed", message: "the router refused" },
    });
    expect((await rollback(connector(silent), "shop", "prm-old", null)).done).toBe(false);
  });
});
