import { HttpError, readJson, requireUser, route } from "@/lib/auth";
import { completeVideo } from "@/lib/videos";

/** Loom's CompleteVideo: the desktop app calls this once the multipart upload is done. */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const body = await readJson<{ durationMs?: unknown; size?: unknown }>(req);
  if (typeof body.durationMs !== "number" || typeof body.size !== "number") throw new HttpError(400, "durationMs and size are required");
  await completeVideo((await params).id, user, body.durationMs, body.size);
  return Response.json({ ok: true });
});
