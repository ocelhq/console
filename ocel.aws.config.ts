import { buildEnv, defineConfig } from "ocel/config";
import { cloudflareDns } from "ocel/dns";
import { cloudflare } from "ocel/edge";
import awsProvider from "ocel/providers/aws";
import { z } from "zod";

const target = buildEnv({
  AWS_REGION: z.string().default("us-east-1"),
  CONSOLE_DOMAIN: z.string().optional(),
});

export default defineConfig({
  $schema: "https://ocel.dev/schema/0.0.1/ocel.schema.json",
  slug: "console",
  provider: awsProvider({ region: target.AWS_REGION }),
  edge: cloudflare(),
  dns: cloudflareDns(),
  apps: [{ name: "console", path: "apps/web" }],
  discovery: { paths: ["packages/infra/src"] },
  bindings: { postgres: { main: { url: { $env: "NEON_DATABASE_URL" } } } },
  ...(target.CONSOLE_DOMAIN ? { domains: { production: target.CONSOLE_DOMAIN } } : {}),
});
