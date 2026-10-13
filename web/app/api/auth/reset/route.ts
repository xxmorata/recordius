import { createSession, readJson, route, setSessionCookie } from "@/lib/auth";
import { consumePasswordReset } from "@/lib/workspace";

export const POST = route(async (req: Request) => {
  const body = await readJson<{ token?: string; password?: string }>(req);
  const userId = await consumePasswordReset(String(body.token ?? ""), String(body.password ?? ""));
  await setSessionCookie(await createSession(userId, req.headers.get("user-agent")));
  return Response.json({ ok: true });
});
