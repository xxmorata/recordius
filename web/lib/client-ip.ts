import { isIP } from "node:net";

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
  // Without a forwarded chain there is no trustworthy address (x-real-ip is only set by Vercel's edge).
  return "unknown";
}

/**
 * Rate-limit key for an address. IPv4-mapped IPv6 (::ffff:1.2.3.4) counts as the IPv4 address; other
 * IPv6 clients usually control a whole /64, so they're limited per /64. Anything unparsable is used as-is.
 */
export function ipBucket(raw: string): string {
  let ip = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip); // [::1]:443
  if (bracketed) ip = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":")); // 1.2.3.4:443
  ip = ip.split("%")[0];
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return raw;
  // Expand to eight 16-bit groups (an embedded dotted quad becomes the last two).
  let text = ip.toLowerCase();
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (quad) {
    const [a, b, c, d] = quad[1].split(".").map(Number);
    text = text.slice(0, -quad[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map((g) => parseInt(g, 16));
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible) are the IPv4 address.
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || (groups[5] === 0 && groups[6] !== 0))) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}
