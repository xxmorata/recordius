import { createSession, readJson, route, setSessionCookie } from "@/lib/auth";
import { authenticate } from "@/lib/workspace";

export const POST = route(async (req: Request) => {
  const body = await readJson<{ email?: string; password?: string }>(req);
  const userId = await authenticate(String(body.email ?? ""), String(body.password ?? ""));
  await setSessionCookie(await createSession(userId, req.headers.get("user-agent")));
  return Response.json({ ok: true });
});
