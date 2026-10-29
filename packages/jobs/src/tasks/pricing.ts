import { db } from "@console/db";
import {
  awsPriceListFromEnv,
  gcpFromEnv,
  type IngestTarget,
  ingestService,
  prepareIngest,
  readManifest,
} from "@console/pricing";
import { task } from "ocel/task";

const RETRY = { maxAttempts: 3, minDelay: "1m", maxDelay: "30m" } as const;

export function timeLimitedTask(environment: NodeJS.ProcessEnv): boolean {
  return environment.AWS_LAMBDA_FUNCTION_NAME !== undefined || environment.K_SERVICE !== undefined;
}

export const pricingIngestService = task<IngestTarget>("pricing-ingest-service", {
  retry: RETRY,
  concurrency: 2,
  run: async (target) => {
    const result = await ingestService(
      {
        database: db,
        gcp: gcpFromEnv,
        awsPriceList: awsPriceListFromEnv(),
        timeLimitedTask: timeLimitedTask(process.env),
      },
      target,
    );
    const line = `pricing: ${result.vendor} ${result.service} ${result.outcome} ${result.version}${result.via ? ` via ${result.via}` : ""}: ${result.products} products, ${result.skipped} skipped`;
    if (result.reason) console.warn(`${line}: ${result.reason}`);
    else console.info(line);
  },
});

export const pricingIngest = task("pricing-ingest", {
  cron: "17 4 * * *",
  retry: RETRY,
  run: async () => {
    const { targets, dropped } = await prepareIngest({ gcp: gcpFromEnv }, readManifest().entries);
    if (dropped) console.warn(`pricing: ${dropped}`);
    const day = new Date().toISOString().slice(0, 10);
    await pricingIngestService.batchTrigger(
      targets.map((target) => ({
        payload: target,
        options: {
          idempotencyKey: `pricing-ingest:${day}:${target.vendor}/${target.service}`,
        },
      })),
    );
  },
});
