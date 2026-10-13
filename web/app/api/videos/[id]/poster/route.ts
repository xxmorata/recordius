import { viewUrl } from "@/lib/blob";
import { publicPreview } from "@/lib/videos";

/**
 * Stable thumbnail URL for link previews (Slack, Notion, iMessage cache it for a long time; presigned
 * URLs expire). Only for videos anyone can watch; redirects to a short-lived signed URL.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const preview = await publicPreview((await params).id);
  if (!preview?.thumbPath) return new Response("Not found", { status: 404 });
  return Response.redirect(await viewUrl(preview.thumbPath, 60 * 60 * 1000), 302);
}
