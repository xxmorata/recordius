/** Public origin of this deployment, without a trailing slash. */
export function appUrl(req?: Request): string {
  const configured = process.env.APP_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (req) {
    const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    return `${proto}://${host}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/**
 * Cookies are marked Secure whenever the site is served over https (always in a real deployment).
 * On a plain-http trial (http://localhost, a LAN address) they can't be, or browsers would drop them.
 */
export function secureCookies(): boolean {
  return appUrl().startsWith("https://");
}

export function openSignupAllowed(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ALLOW_OPEN_SIGNUP ?? "");
}

export function authSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) throw new Error("AUTH_SECRET must be set to a long random string");
  return s;
}
