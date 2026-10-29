import { buildEnv, defineConfig } from "ocel/config";
import { cloudflareDns } from "ocel/dns";
import { cloudflare } from "ocel/edge";
import awsProvider from "ocel/providers/aws";
import { z } from "zod";

const target = buildEnv({
  AWS_REGION: z.string().default("us-east-1"),
  CONSOLE_DOMAIN: z.string().optional(),
  VARIABLES_KMS_KEY: z.string().optional(),
});

export default defineConfig({
  slug: "console",
  transforms: ["./transforms/pricing.transform.ts"],
  provider: awsProvider({
    region: target.AWS_REGION,
    edge: cloudflare(),
    dns: cloudflareDns(),
    ...(target.VARIABLES_KMS_KEY ? { variablesKey: target.VARIABLES_KMS_KEY } : {}),
  }),
  apps: [{ name: "console", path: "apps/web" }],
  discovery: { paths: ["packages/infra/src", "packages/jobs/src/tasks"] },
  lifecycle: { preBuild: "bun run --filter @console/db db:migrate" },
  bindings: { postgres: { main: { url: { $env: "NEON_DATABASE_URL" } } } },
  ...(target.CONSOLE_DOMAIN ? { domains: { production: target.CONSOLE_DOMAIN } } : {}),
});
