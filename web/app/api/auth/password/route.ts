import { createSession, readJson, requireUser, route, setSessionCookie } from "@/lib/auth";
import { changePassword } from "@/lib/workspace";

export const POST = route(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ current?: string; next?: string }>(req);
  await changePassword(user, String(body.current ?? ""), String(body.next ?? ""));
  // changePassword signs out every session; keep this one.
  await setSessionCookie(await createSession(user.id, req.headers.get("user-agent")));
  return Response.json({ ok: true });
});
