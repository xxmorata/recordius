import { currentUser, readJson, requireUser, route } from "@/lib/auth";
import { deleteVideo, getVideoFor, updateVideo, type VideoPatch } from "@/lib/videos";

type Ctx = { params: Promise<{ id: string }> };

/** Viewer-facing: the share page polls this while the upload finishes. URLs are only included for allowed viewers. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { video, access } = await getVideoFor((await params).id, await currentUser({ device: true }));
  return Response.json({ ...video, access }, { headers: { "cache-control": "no-store" } });
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const body = await readJson<VideoPatch>(req);
  await updateVideo((await params).id, user, body);
  return Response.json({ ok: true });
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  await deleteVideo((await params).id, await requireUser({ device: true }));
  return Response.json({ ok: true });
});
