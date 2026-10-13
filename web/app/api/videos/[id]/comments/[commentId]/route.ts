import { currentUser, route } from "@/lib/auth";
import { deleteComment } from "@/lib/videos";

export const DELETE = route(async (_req: Request, { params }: { params: Promise<{ id: string; commentId: string }> }) => {
  const { id, commentId } = await params;
  await deleteComment(id, commentId, await currentUser());
  return Response.json({ ok: true });
});
