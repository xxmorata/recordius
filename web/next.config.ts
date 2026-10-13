import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `standalone` makes the Docker image self-contained; Vercel ignores it.
  output: process.env.DOCKER_BUILD ? "standalone" : undefined,
  images: { unoptimized: true },
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
