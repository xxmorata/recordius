import { currentUser, errorResponse, HttpError } from "@/lib/auth";
import { getVideoFor } from "@/lib/videos";

/** "Download" in lists: checks access now and redirects to a short-lived signed download link. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { video } = await getVideoFor((await params).id, await currentUser({ device: true }));
    if (!video.downloadUrl) throw new HttpError(403, "This video can't be downloaded");
    return Response.redirect(video.downloadUrl, 302);
  } catch (err) {
    return errorResponse(err);
  }
}
