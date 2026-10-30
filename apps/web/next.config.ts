import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  skipTrailingSlashRedirect: true,
  transpilePackages: [
    "@console/api",
    "@console/auth",
    "@console/connectors",
    "@console/db",
    "@console/git",
    "@console/infra",
    "@console/targets",
  ],
};

export default nextConfig;
