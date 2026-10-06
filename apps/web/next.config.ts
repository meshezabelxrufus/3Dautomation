import path from "node:path";
import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";

/**
 * No third-party scripts, styles, fonts or images are used. 'unsafe-inline' is needed for the inline
 * scripts/styles Next.js emits (RSC payload, motion); 'unsafe-eval' and ws: only in development.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (apps/web/Dockerfile).
  output: "standalone",
  // Monorepo: trace dependencies from the workspace root so hoisted packages are included.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  poweredByHeader: false,
  // HSTS is set by the TLS-terminating reverse proxy in production (docs/DEVELOPMENT.md).
  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
};

export default nextConfig;
