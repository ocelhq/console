import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  PriceMiss_Reason,
  type PriceQuerySchema,
  PricingService,
  PurchaseOption,
} from "@console/connectors/gen/console/v1/pricing_pb";
import { db } from "@console/db";
import { setupTestDatabase } from "@console/db/testing";
import { seedCatalog } from "@console/pricing/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestSessionWithOrganization } from "../../../test/auth-harness";
import { configuredPricingLimits, type PricingLimits } from "../../ratelimit/pricing";
import { CONNECT_PREFIX, connectHandler } from "./route";

function freshAddress(): string {
  return `2001:db8:${Array.from(crypto.getRandomValues(new Uint16Array(2)), (group) => group.toString(16)).join(":")}::1`;
}

function pricing(
  headers: Record<string, string> = { "X-Forwarded-For": freshAddress() },
  limits: Partial<PricingLimits> = {},
) {
  const connect = connectHandler({
    notify: async () => {},
    git: () => undefined,
    pricingLimits: { ...configuredPricingLimits(), ...limits },
  });
  return createClient(
    PricingService,
    createConnectTransport({
      baseUrl: `http://localhost${CONNECT_PREFIX}`,
      interceptors: [
        (next) => (request) => {
          for (const [name, value] of Object.entries(headers)) {
            request.header.set(name, value);
          }
          return next(request);
        },
      ],
      fetch: (input, init) => connect(new Request(input, init)),
    }),
  );
}

async function errorOf(call: Promise<unknown>): Promise<ConnectError> {
  return ConnectError.from(
    await call.then(
      () => null,
      (e: unknown) => e,
    ),
  );
}

const service = `TestService-${crypto.randomUUID()}`;

type QueryInit = MessageInitShape<typeof PriceQuerySchema>;

function query(overrides: Partial<QueryInit> = {}): QueryInit {
  const base: QueryInit = {
    vendor: "aws",
    service,
    region: "eu-west-2",
    attributes: { usagetype: "Request" },
    purchaseOption: PurchaseOption.ON_DEMAND,
  };
  return { ...base, ...overrides } as QueryInit;
}

const product = {
  region: "eu-west-2",
  productFamily: "Serverless",
  unit: "Request",
  tiers: [{ start: "0", price: "0.0000002" }],
  sourceUrl: "https://pricing.example.test/offer.json",
};

describe("PricingService over Connect", () => {
  beforeAll(async () => {
    await setupTestDatabase();
    await seedCatalog(db, {
      vendor: "aws",
      service,
      version: "20261022183959",
      products: [
        { ...product, sku: "SKU-ONE", attributes: { usagetype: "Request", group: "one" } },
        { ...product, sku: "SKU-TWO", attributes: { usagetype: "Duration", group: "two" } },
        { ...product, sku: "SKU-THREE", attributes: { usagetype: "Duration", group: "three" } },
      ],
    });
  });

  describe("Lookup", () => {
    it("answers an anonymous caller each query in order", async () => {
      const looked = await pricing().lookup({
        queries: [
          query(),
          query({ attributes: { usagetype: "Duration" } }),
          query({ attributes: { usagetype: "Storage" } }),
          query({ vendor: "gcp", service: "152E-C115-5142" }),
          query(),
        ],
      });

      expect(looked.currency).toBe("USD");
      expect(looked.answers.map((answer) => answer.outcome)).toEqual([
        {
          case: "price",
          value: expect.objectContaining({
            sku: "SKU-ONE",
            unit: "Request",
            tiers: [expect.objectContaining({ start: "0", price: "0.0000002" })],
            catalogVersion: "20261022183959",
            sourceUrl: "https://pricing.example.test/offer.json",
          }),
        },
        {
          case: "ambiguous",
          value: expect.objectContaining({ candidateSkus: ["SKU-THREE", "SKU-TWO"], matches: 2 }),
        },
        {
          case: "miss",
          value: expect.objectContaining({ reason: PriceMiss_Reason.NO_MATCH }),
        },
        {
          case: "miss",
          value: expect.objectContaining({ reason: PriceMiss_Reason.CATALOG_NOT_SEEDED }),
        },
        { case: "price", value: expect.objectContaining({ sku: "SKU-ONE" }) },
      ]);
    });

    it("refuses a query with no purchase option", async () => {
      const error = await errorOf(
        pricing().lookup({ queries: [query({ purchaseOption: PurchaseOption.UNSPECIFIED })] }),
      );
      expect(error.code).toBe(Code.InvalidArgument);
    });

    it("refuses more than 500 queries in one call", async () => {
      const error = await errorOf(
        pricing().lookup({ queries: Array.from({ length: 501 }, () => query()) }),
      );
      expect(error.code).toBe(Code.InvalidArgument);
    });

    it("refuses a call with no queries", async () => {
      const error = await errorOf(pricing().lookup({ queries: [] }));
      expect(error.code).toBe(Code.InvalidArgument);
    });
  });

  describe("the limits", () => {
    it("refuses an anonymous address past its burst, with Retry-After", async () => {
      const caller = pricing(
        { "X-Forwarded-For": freshAddress() },
        { anonymous: { burst: 2, perHour: 60 } },
      );
      await caller.lookup({ queries: [query()] });
      await caller.lookup({ queries: [query()] });

      const error = await errorOf(caller.lookup({ queries: [query()] }));
      expect(error.code).toBe(Code.ResourceExhausted);
      expect(Number(error.metadata.get("Retry-After"))).toBeGreaterThan(0);

      await expect(pricing().lookup({ queries: [query()] })).resolves.toBeDefined();
    });

    it("limits a signed-in caller by organization, whatever its address", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const signedIn = (address: string) =>
          pricing(
            { Authorization: `Bearer ${session.token}`, "X-Forwarded-For": address },
            { organization: { burst: 1, perHour: 60 }, anonymous: { burst: 1, perHour: 60 } },
          );
        await signedIn(freshAddress()).lookup({ queries: [query()] });

        const error = await errorOf(signedIn(freshAddress()).lookup({ queries: [query()] }));
        expect(error.code).toBe(Code.ResourceExhausted);
        expect(error.message).toContain("organization");
      } finally {
        await session.cleanup();
      }
    });

    it("takes a bearer that is no session as an anonymous caller", async () => {
      const caller = pricing(
        { Authorization: "Bearer not-a-session", "X-Forwarded-For": freshAddress() },
        { anonymous: { burst: 1, perHour: 60 } },
      );
      await caller.lookup({ queries: [query()] });

      const error = await errorOf(caller.lookup({ queries: [query()] }));
      expect(error.code).toBe(Code.ResourceExhausted);
      expect(error.message).toContain("address");
    });
  });
});
