import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  transpilePackages: [
    "@console/api",
    "@console/auth",
    "@console/connectors",
    "@console/db",
    "@console/endpoints",
    "@console/git",
    "@console/infra",
    "@console/targets",
  ],
};

export default nextConfig;
