import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Server-only modules (Hyperswitch client) must not leak to the client bundle.
  serverExternalPackages: [],
};

export default nextConfig;
