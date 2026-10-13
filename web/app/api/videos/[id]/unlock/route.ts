import { readJson, route } from "@/lib/auth";
import { unlockVideo } from "@/lib/videos";

/** Password-protected links: a correct password sets a cookie that unlocks this video for 30 days. */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const body = await readJson<{ password?: string }>(req);
  await unlockVideo((await params).id, String(body.password ?? ""));
  return Response.json({ ok: true });
});
