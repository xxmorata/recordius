import { readJson, route } from "@/lib/auth";
import { unlockVideo } from "@/lib/videos";

/** Password-protected links: a correct password sets a cookie that unlocks this video for 30 days. */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const body = await readJson<{ password?: string }>(req);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  await unlockVideo((await params).id, String(body.password ?? ""), ip);
  return Response.json({ ok: true });
});
