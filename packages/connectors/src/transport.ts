import type { DescMethod } from "@bufbuild/protobuf";
import {
  type Client,
  Code,
  ConnectError,
  createClient,
  type Interceptor,
  type Transport,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import { VersionUnservedSchema } from "./gen/endpoint/v1/endpoint_pb";
import { RefusalCode, RefusalSchema } from "./gen/provider/contract/v1/contract_pb";
import { VariableStoreService } from "./gen/provider/variablestore/v1/variablestore_pb";
import { RunnerService } from "./gen/runner/v1/runner_pb";
import { type Outcome, refuse, ValueError } from "./item";

export type Tier = "production" | "preview";

export type Authorize = (call: DescMethod) => Promise<string>;

export interface Endpoint {
  url: string;
  controlUrl: string;
  authorize: Authorize;
}

export interface Clients {
  runner: Client<typeof RunnerService>;
  variableStore: Client<typeof VariableStoreService>;
}

const RUNNER_CALL_TIMEOUT_MS = 15_000;

export function transportTo(
  url: string,
  authorize: Authorize,
  options: { interceptors?: Interceptor[]; timeoutMs?: number } = {},
): Transport {
  const bearing: Interceptor = (next) => async (request) => {
    request.header.set("Authorization", `Bearer ${await authorize(request.method)}`);
    return next(request);
  };
  return createConnectTransport({
    baseUrl: url,
    httpVersion: "1.1",
    interceptors: [bearing, ...(options.interceptors ?? [])],
    defaultTimeoutMs: options.timeoutMs,
  });
}

export function clientsOf(endpoint: Endpoint): Clients {
  return {
    runner: createClient(
      RunnerService,
      transportTo(endpoint.url, endpoint.authorize, { timeoutMs: RUNNER_CALL_TIMEOUT_MS }),
    ),
    variableStore: createClient(
      VariableStoreService,
      transportTo(endpoint.controlUrl, endpoint.authorize),
    ),
  };
}

const valueCodes = new Map<Code, number>([
  [Code.FailedPrecondition, 409],
  [Code.InvalidArgument, 400],
  [Code.NotFound, 404],
  [Code.AlreadyExists, 409],
]);

export async function ask<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { done: true, result: await run() };
  } catch (thrown) {
    if (thrown instanceof ConnectError) {
      if (
        thrown
          .findDetails(RefusalSchema)
          .some((refusal) => refusal.code === RefusalCode.NEEDS_RUNNER)
      ) {
        return refuse("needs-runner", thrown.rawMessage);
      }
      if (thrown.findDetails(VersionUnservedSchema).length > 0) {
        return refuse("incompatible", thrown.rawMessage);
      }
      const status = valueCodes.get(thrown.code);
      if (status !== undefined) throw new ValueError(status, thrown.rawMessage);
      if (thrown.code === Code.PermissionDenied) {
        return refuse("denied", thrown.rawMessage);
      }
      if (thrown.code === Code.Unimplemented) {
        return refuse("incompatible", thrown.rawMessage);
      }
      if (thrown.code === Code.Unauthenticated) {
        return refuse("unauthenticated", `the console's token was refused: ${thrown.rawMessage}`);
      }
      return refuse("offline", thrown.rawMessage);
    }
    if (thrown instanceof ValueError) throw thrown;
    return refuse("offline", thrown instanceof Error ? thrown.message : String(thrown));
  }
}
