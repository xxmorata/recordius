/**
 * Client IP for rate limiting, taken only from headers the client can't forge:
 *  - on Vercel, `x-vercel-forwarded-for` / `x-real-ip` are set by the platform;
 *  - behind your own proxies, the right-most `x-forwarded-for` entries are the ones they appended.
 *    Set TRUSTED_PROXY_HOPS to how many proxies sit in front of the app (default 1).
 */
export function clientIp(req: Request): string {
  if (process.env.VERCEL) {
    const v = req.headers.get("x-vercel-forwarded-for") ?? req.headers.get("x-real-ip");
    if (v) return v.split(",")[0].trim();
  }
  const chain = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const hops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS) || 1);
  if (chain.length) return chain[Math.max(0, chain.length - hops)];
  return req.headers.get("x-real-ip") ?? "unknown";
}
