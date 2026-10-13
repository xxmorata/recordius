import { createSession, readJson, route, setSessionCookie } from "@/lib/auth";
import { consumePasswordReset } from "@/lib/workspace";
import { clientIp } from "@/lib/client-ip";
import { ipKey, limit } from "@/lib/rate-limit";

export const POST = route(async (req: Request) => {
  const body = await readJson<{ token?: string; password?: string }>(req);
  const attempt = await limit([{ scope: "reset-ip", key: ipKey(clientIp(req)), limit: 20, window: "1 hour" }]);
  const userId = await consumePasswordReset(String(body.token ?? ""), String(body.password ?? ""));
  await attempt.release();
  await setSessionCookie(await createSession(userId, req.headers.get("user-agent")));
  return Response.json({ ok: true });
});
