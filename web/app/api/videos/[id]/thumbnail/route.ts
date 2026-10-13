import { requireUser, route } from "@/lib/auth";
import { markThumbnail } from "@/lib/videos";

export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  await markThumbnail((await params).id, await requireUser());
  return Response.json({ ok: true });
});
