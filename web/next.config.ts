import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `standalone` makes the Docker image self-contained; Vercel ignores it.
  output: process.env.DOCKER_BUILD ? "standalone" : undefined,
  images: { unoptimized: true },
  serverExternalPackages: ["postgres"],
  // Migrations are read from disk at runtime (instrumentation.ts, /setup); make sure every function bundle has them.
  outputFileTracingIncludes: { "/**": ["./db/migrations/*.sql"] },
  poweredByHeader: false,
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
    ];
    return [
      // No other site may frame the app (clickjacking)…
      { source: "/:path((?!embed/).*)", headers: [...common, { key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] },
      // …except the embeddable player, which exists to be put in iframes.
      { source: "/embed/:path*", headers: [...common, { key: "Content-Security-Policy", value: "frame-ancestors *" }] },
    ];
  },
};

export default nextConfig;
