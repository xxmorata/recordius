import { HttpError, requireUser, route } from "@/lib/auth";
import { markThumbnail, setCustomThumbnail } from "@/lib/videos";

/**
 * Without a body (desktop app): the recorder's own thumbnail was uploaded — mark it.
 * With a form file (web): replace the thumbnail with the chosen frame.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireUser();
  if (!(req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    await markThumbnail(id, user);
    return Response.json({ ok: true });
  }
  const file = (await req.formData()).get("file");
  if (!(file instanceof File) || file.type !== "image/jpeg") throw new HttpError(400, "Send the thumbnail as a JPEG image");
  if (file.size > 4 * 1024 ** 2) throw new HttpError(400, "The thumbnail is too large");
  const thumbUrl = await setCustomThumbnail(id, user, Buffer.from(await file.arrayBuffer()));
  return Response.json({ thumbUrl });
});
