import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (apps/web/Dockerfile).
  output: "standalone",
  // Monorepo: trace dependencies from the workspace root so hoisted packages are included.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  poweredByHeader: false,
};

export default nextConfig;
