import { createSession, readJson, route, setSessionCookie } from "@/lib/auth";
import { acceptInvite, previewInvite } from "@/lib/workspace";
import { clientIp } from "@/lib/client-ip";
import { ipKey, limit } from "@/lib/rate-limit";

type Ctx = { params: Promise<{ token: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  return Response.json(await previewInvite((await params).token));
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  const body = await readJson<{ name?: string; email?: string; password?: string }>(req);
  await limit([{ scope: "join-ip", key: ipKey(clientIp(req)), limit: 10, window: "1 hour" }], "Too many sign-ups from your network. Try again in an hour.");
  const userId = await acceptInvite((await params).token, {
    name: String(body.name ?? ""),
    email: String(body.email ?? ""),
    password: String(body.password ?? ""),
  });
  await setSessionCookie(await createSession(userId, req.headers.get("user-agent")));
  return Response.json({ ok: true });
});
