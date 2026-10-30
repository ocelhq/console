import { create } from "@bufbuild/protobuf";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { Tier as RecordedTier } from "./gen/common/environment/v1/environment_pb";
import type { OperationResult } from "./gen/common/progress/v1/progress_pb";
import { EdgeSelectionSchema, ProviderService } from "./gen/provider/contract/v1/contract_pb";
import { type Outcome, refuse } from "./item";
import { ask, type Endpoint, type Tier, transportTo } from "./transport";

export const SLUG_HEADER = "Ocel-Slug";
export const TIER_HEADER = "Ocel-Tier";

export function providerOf(endpoint: Endpoint, slug: string, tier: Tier) {
  const placed: Interceptor = (next) => async (request) => {
    request.header.set(SLUG_HEADER, slug);
    request.header.set(TIER_HEADER, tier);
    return next(request);
  };
  return createClient(
    ProviderService,
    transportTo(endpoint.controlUrl, endpoint.authorize, { interceptors: [placed] }),
  );
}

export interface RolledBack {
  promotionId: string;
  releases: Record<string, string>;
}

async function recordedProject(client: ReturnType<typeof providerOf>, slug: string) {
  try {
    return await client.getProject({ slug, tiers: [RecordedTier.PRODUCTION] });
  } catch {
    return undefined;
  }
}

export async function rollback(
  endpoint: Endpoint,
  slug: string,
  to: string,
  deployedEdge: string | null,
): Promise<Outcome<RolledBack>> {
  const client = providerOf(endpoint, slug, "production");
  const project = await recordedProject(client, slug);
  const edge = project?.edge?.kind
    ? project.edge
    : deployedEdge
      ? create(EdgeSelectionSchema, { kind: deployedEdge })
      : undefined;
  const streamed = await ask(async () => {
    let result: OperationResult | undefined;
    for await (const event of client.rollback({
      slug,
      to,
      edge,
      projectRegistry: project?.registry,
    })) {
      if (event.body.case === "result") {
        result = event.body.value;
      }
    }
    return result;
  });
  if (!streamed.done) {
    return streamed;
  }
  const result = streamed.result;
  if (result === undefined) {
    return refuse("failed", "the endpoint ended the rollback without saying how it went");
  }
  if (!result.success || result.refused) {
    return refuse("failed", result.error || "the endpoint could not roll back");
  }
  return {
    done: true,
    result: {
      promotionId: result.promotionId,
      releases: Object.fromEntries(result.apps.map((app) => [app.app, app.release])),
    },
  };
}
