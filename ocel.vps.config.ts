import { buildEnv, defineConfig } from "ocel/config";
import vpsProvider from "ocel/providers/vps";
import { z } from "zod";

const target = buildEnv({
  CONSOLE_VPS_HOST: z.string().min(1),
  CONSOLE_VPS_USER: z.string().optional(),
  CONSOLE_VPS_PORT: z.coerce.number().optional(),
  CONSOLE_DOMAIN: z.string().optional(),
});

export default defineConfig({
  $schema: "https://ocel.dev/schema/0.0.1/ocel.schema.json",
  slug: "console",
  provider: vpsProvider({
    ssh: {
      host: target.CONSOLE_VPS_HOST,
      user: target.CONSOLE_VPS_USER,
      port: target.CONSOLE_VPS_PORT,
    },
  }),
  apps: [
    {
      name: "console",
      path: "apps/web",
      compute: "container",
      health: { path: "/api/health" },
    },
  ],
  discovery: { paths: ["packages/infra/src", "packages/jobs/src/tasks"] },
  ...(target.CONSOLE_DOMAIN ? { domains: { production: target.CONSOLE_DOMAIN } } : {}),
});
