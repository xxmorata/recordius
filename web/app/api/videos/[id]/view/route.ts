import { currentUser, route } from "@/lib/auth";
import { getVideoFor, recordView } from "@/lib/videos";

/** Called by the player when playback starts; owners are never counted. */
export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const { access } = await getVideoFor(id, await currentUser());
  await recordView(id, access);
  return Response.json({ ok: true });
});
