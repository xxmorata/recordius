import { requireUser, route } from "@/lib/auth";
import { reissueUploadTokens } from "@/lib/videos";

/** Desktop app: new upload tokens to retry an unfinished upload from the local copy. */
export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  return Response.json({ upload: await reissueUploadTokens((await params).id, await requireUser()) });
});
