import { buildEnv, defineConfig } from "ocel/config";
import gcpProvider from "ocel/providers/gcp";
import { z } from "zod";

const target = buildEnv({
  GCP_PROJECT: z.string().min(1),
  GCP_REGION: z.string().default("us-central1"),
  CONSOLE_DOMAIN: z.string().optional(),
});

export default defineConfig({
  slug: "console",
  provider: gcpProvider({ project: target.GCP_PROJECT, region: target.GCP_REGION }),
  apps: [{ name: "console", path: "apps/web" }],
  discovery: { paths: ["packages/infra/src", "packages/jobs/src/tasks"] },
  lifecycle: { preBuild: "bun run --filter @console/db db:migrate" },
  ...(target.CONSOLE_DOMAIN ? { domains: { production: target.CONSOLE_DOMAIN } } : {}),
});
