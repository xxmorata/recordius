import { secureCookies } from "@/lib/env";
import { cookies } from "next/headers";
import { currentUser, route } from "@/lib/auth";
import { randomToken } from "@/lib/ids";
import { getVideoFor, recordProgress } from "@/lib/videos";

const ANON_COOKIE = "rcd_vk";

/**
 * The player reports how far someone has watched: once when playback starts, then every few seconds and
 * when the tab is hidden (via sendBeacon, so the body may arrive as text/plain).
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await currentUser();
  const { access } = await getVideoFor(id, user);
  let positionMs = 0;
  try {
    positionMs = Number(JSON.parse((await req.text()) || "{}").positionMs) || 0;
  } catch {}
  let anonKey: string | null = null;
  if (!user) {
    const jar = await cookies();
    anonKey = jar.get(ANON_COOKIE)?.value ?? null;
    if (!anonKey || !/^[\w-]{16,64}$/.test(anonKey)) {
      anonKey = randomToken(16);
      jar.set(ANON_COOKIE, anonKey, {
        httpOnly: true,
        secure: secureCookies(),
        sameSite: secureCookies() ? "none" : "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
  }
  await recordProgress(id, access, { userId: user?.id ?? null, anonKey }, positionMs);
  return Response.json({ ok: true });
});
