import { createServer, type Server } from "node:http";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it } from "vitest";
import { RefusalCode, RefusalSchema } from "./gen/provider/contract/v1/contract_pb";
import { VariableStoreService } from "./gen/provider/variablestore/v1/variablestore_pb";
import { RunnerService } from "./gen/runner/v1/runner_pb";
import { providerOf, SLUG_HEADER, TIER_HEADER } from "./provider";
import { clientsOf, type Endpoint } from "./transport";
import { list } from "./variables";

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function listening(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(
        typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "",
      );
    });
  });
}

function answering(seen: string[], headers: string[] = []): Promise<string> {
  return listening(
    createServer((request, response) => {
      seen.push(request.headers.authorization ?? "");
      headers.push(...Object.keys(request.headers));
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/proto" });
        response.end();
      });
    }),
  );
}

function connector(url: string, authorize: Endpoint["authorize"]): Endpoint {
  return { url, controlUrl: url, authorize };
}

describe("an endpoint", () => {
  it("sends a token minted for the call as a bearer credential", async () => {
    const seen: string[] = [];
    const url = await answering(seen);
    const asked: unknown[] = [];

    await clientsOf(
      connector(url, async (call) => {
        asked.push(call);
        return `minted.for.${call.name}`;
      }),
    ).variableStore.listValues({ slug: "shop" });

    expect(asked).toEqual([VariableStoreService.method.listValues]);
    expect(seen).toEqual(["Bearer minted.for.ListValues"]);
  });

  it("opens no provider session and names no version", async () => {
    const headers: string[] = [];
    const url = await answering([], headers);

    await clientsOf(connector(url, async () => "t")).variableStore.listValues({});

    expect(headers).not.toContain("ocel-session");
    expect(headers).not.toContain("ocel-version");
  });

  it("reaches the runner at the endpoint's url and control calls at its control url", async () => {
    const runnerSeen: string[] = [];
    const controlSeen: string[] = [];
    const endpoint: Endpoint = {
      url: await answering(runnerSeen),
      controlUrl: await answering(controlSeen),
      authorize: async (call) => call.name,
    };

    await clientsOf(endpoint).runner.getJob({ jobId: "j" });
    await clientsOf(endpoint).variableStore.listValues({});

    expect(runnerSeen).toEqual([`Bearer ${RunnerService.method.getJob.name}`]);
    expect(controlSeen).toEqual(["Bearer ListValues"]);
  });

  it("names the slug and tier a sessionless provider call is for", async () => {
    const seen: Record<string, string>[] = [];
    const url = await listening(
      createServer((request, response) => {
        seen.push({
          slug: String(request.headers[SLUG_HEADER.toLowerCase()] ?? ""),
          tier: String(request.headers[TIER_HEADER.toLowerCase()] ?? ""),
        });
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "Content-Type": "application/proto" });
          response.end();
        });
      }),
    );

    await providerOf(
      connector(url, async () => "t"),
      "shop",
      "production",
    ).getPreviewWildcard({});

    expect(seen).toEqual([{ slug: "shop", tier: "production" }]);
  });

  it("reads an endpoint that runs no provisioning engine as needing a runner", async () => {
    const url = await listening(
      createServer(
        connectNodeAdapter({
          routes: (router) =>
            router.service(VariableStoreService, {
              listValues: () => {
                throw new ConnectError(
                  "this endpoint runs no provisioning engine",
                  Code.FailedPrecondition,
                  undefined,
                  [{ desc: RefusalSchema, value: { code: RefusalCode.NEEDS_RUNNER } }],
                );
              },
            }),
        }),
      ),
    );

    const answer = await list(
      connector(url, async () => "t"),
      "production",
      "shop",
    );

    expect(answer.done === false && answer.refusal.reason).toBe("needs-runner");
  });
});
