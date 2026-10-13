import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `standalone` makes the Docker image self-contained; Vercel ignores it.
  output: process.env.DOCKER_BUILD ? "standalone" : undefined,
  images: { unoptimized: true },
  serverExternalPackages: ["postgres"],
  // Migrations are read from disk at runtime (instrumentation.ts, /setup); make sure every function bundle has them.
  outputFileTracingIncludes: { "/**": ["./db/migrations/*.sql"] },
};

export default nextConfig;
