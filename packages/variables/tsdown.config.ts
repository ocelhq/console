import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/model.ts"],
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: true,
  minify: false,
  unbundle: true,
  clean: true,
});
