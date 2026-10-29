import { db } from "@console/db";
import { awsPriceListFromEnv } from "../aws-price-list";
import { gcpFromEnv } from "../gcp";
import { ingestService, prepareIngest, readManifest } from "../ingest";

const usage =
  "usage: bun run pricing:ingest <vendor>/<service>... | all\n  e.g. bun run pricing:ingest aws/AWSLambda gcp/152E-C115-5142";

function refuse(message: string): never {
  console.error(`${message}\n${usage}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const entries = readManifest().entries;
if (args.length === 0) refuse("name the services to ingest");
const wanted =
  args.length === 1 && args[0] === "all"
    ? entries
    : args.map(
        (arg) =>
          entries.find((entry) => `${entry.vendor}/${entry.service}` === arg) ??
          refuse(`the ingest manifest names no ${arg}`),
      );

const { targets, dropped } = await prepareIngest({ gcp: gcpFromEnv }, wanted);
let failed = false;
if (dropped) {
  console.error(dropped);
  failed = true;
}
const awsPriceList = awsPriceListFromEnv();
for (const target of targets) {
  const name = `${target.vendor}/${target.service}`;
  const started = performance.now();
  try {
    const result = await ingestService({ database: db, gcp: gcpFromEnv, awsPriceList }, target);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `${name}: ${result.outcome} ${result.version}${result.via ? ` via ${result.via}` : ""}, ${result.products} products, ${result.skipped} skipped, ${seconds}s${result.reason ? `: ${result.reason}` : ""}`,
    );
    for (const skipped of result.skippedSample.slice(0, 3)) {
      console.log(
        `  skipped ${skipped.sku || "-"} ${skipped.region || "(global)"}: ${skipped.reason}`,
      );
    }
  } catch (error) {
    failed = true;
    console.error(`${name}: failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
await db.$client.end();
process.exit(failed ? 1 : 0);
