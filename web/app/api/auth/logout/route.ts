import { destroySession, route } from "@/lib/auth";

export const POST = route(async () => {
  await destroySession();
  return Response.json({ ok: true });
});
