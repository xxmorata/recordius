import { createSession, readJson, route, setSessionCookie } from "@/lib/auth";
import { clientIp } from "@/lib/client-ip";
import { normalizeEmail } from "@/lib/ids";
import { ipKey, limit } from "@/lib/rate-limit";
import { authenticate } from "@/lib/workspace";

export const POST = route(async (req: Request) => {
  const body = await readJson<{ email?: string; password?: string }>(req);
  const email = normalizeEmail(String(body.email ?? ""));
  // Failed sign-ins only: 10 per account and 30 per network in 15 minutes.
  const attempt = await limit(
    [
      { scope: "login-email", key: email, limit: 10, window: "15 minutes" },
      { scope: "login-ip", key: ipKey(clientIp(req)), limit: 30, window: "15 minutes" },
    ],
    "Too many sign-in attempts. Wait 15 minutes and try again.",
  );
  const userId = await authenticate(email, String(body.password ?? ""));
  await attempt.release();
  await setSessionCookie(await createSession(userId, req.headers.get("user-agent")));
  return Response.json({ ok: true });
});
