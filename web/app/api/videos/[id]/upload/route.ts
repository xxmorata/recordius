import { readJson, requireUser, route } from "@/lib/auth";
import { handleUpload } from "@/lib/videos";

/** Signed part / PUT URLs for one video's files (S3-compatible and local storage). */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser({ device: true });
  return Response.json(await handleUpload((await params).id, user, await readJson(req)), { headers: { "cache-control": "no-store" } });
});
