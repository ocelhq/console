import { pg } from "@console/infra";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    get url() {
      return pg.connectionString;
    },
  },
});
