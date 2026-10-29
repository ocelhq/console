import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  type PriceAnswerSchema,
  PriceMiss_Reason,
  type PriceQuery,
  type PricingService,
} from "@console/connectors/gen/console/v1/pricing_pb";
import { db } from "@console/db";
import { lookupPrices, type PriceAnswerResult, type PriceQueryInput } from "@console/pricing";
import { admitPriceLookup, type Limit, type PricingLimits } from "../../ratelimit/pricing";
import { optionalSessionCallerOf } from "./caller";

const missReasons: Record<
  Extract<PriceAnswerResult, { kind: "miss" }>["reason"],
  PriceMiss_Reason
> = {
  catalog_not_seeded: PriceMiss_Reason.CATALOG_NOT_SEEDED,
  no_match: PriceMiss_Reason.NO_MATCH,
};

function inputOf(query: PriceQuery): PriceQueryInput {
  return {
    vendor: query.vendor,
    service: query.service,
    region: query.region,
    productFamily: query.productFamily,
    attributes: { ...query.attributes },
    unit: query.unit,
  };
}

function answerOf(result: PriceAnswerResult): MessageInitShape<typeof PriceAnswerSchema> {
  switch (result.kind) {
    case "price":
      return {
        outcome: {
          case: "price",
          value: {
            sku: result.sku,
            unit: result.unit,
            tiers: result.tiers,
            catalogVersion: result.catalogVersion,
            sourceUrl: result.sourceUrl,
          },
        },
      };
    case "miss":
      return {
        outcome: {
          case: "miss",
          value: { reason: missReasons[result.reason], detail: result.detail },
        },
      };
    case "ambiguous":
      return {
        outcome: {
          case: "ambiguous",
          value: { candidateSkus: result.candidateSkus, matches: result.matches },
        },
      };
  }
}

const refusals: Record<Limit, (seconds: number) => string> = {
  organization: (seconds) => `Too many price lookups from this organization: retry in ${seconds}s`,
  address: (seconds) => `Too many price lookups from this address: retry in ${seconds}s`,
  "all-anonymous": (seconds) =>
    `Too many anonymous price lookups from every address together: sign in, or retry in ${seconds}s`,
};

async function admit(context: HandlerContext, limits: PricingLimits): Promise<void> {
  const admission = await admitPriceLookup(
    db,
    optionalSessionCallerOf(context),
    context.requestHeader,
    limits,
  );
  if (!admission.allowed) {
    throw new ConnectError(
      refusals[admission.limit](admission.retryAfterSeconds),
      Code.ResourceExhausted,
      { "Retry-After": String(admission.retryAfterSeconds) },
    );
  }
}

export function pricingService(limits: () => PricingLimits): ServiceImpl<typeof PricingService> {
  return {
    async lookup(request, context) {
      await admit(context, limits());
      const answers = await lookupPrices(db, request.queries.map(inputOf));
      return { currency: "USD", answers: answers.map(answerOf) };
    },
  };
}
