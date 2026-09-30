import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

const apiUrl = process.env.SONGBIRD_API_URL ?? "http://localhost:8080";

// The dev server refuses its JS chunks to any origin but localhost, so opening the
// app by LAN IP (e.g. from a phone) renders the skeleton and never hydrates. This
// machine's own addresses are safe to allow; anything else must be opted into.
const devOrigins = [
  ...Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal)
    .map((i) => i!.address),
  ...(process.env.SONGBIRD_DEV_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
];

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins,
  // Next allows one dev server per dist dir; e2e sets its own so it can run beside `just dev`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Produces the minimal server bundle the container image copies.
  output: "standalone",
  // Rewrite destinations are baked in at build time, so SONGBIRD_API_URL must be
  // set when building the image, not only when running it.
  // Proxying keeps the browser same-origin so the backend needs no CORS setup in dev.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
      { source: "/healthz", destination: `${apiUrl}/healthz` },
    ];
  },
};

export default nextConfig;
