import { requireUser, route } from "@/lib/auth";
import { viewerStats } from "@/lib/videos";

/** Owner-only: who watched and how far. */
export const GET = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  return Response.json(await viewerStats((await params).id, await requireUser()), { headers: { "cache-control": "no-store" } });
});
