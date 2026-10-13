import { HttpError, requireUser, route } from "@/lib/auth";
import { avatarPath, deletePrefix, putPrivate, viewUrl } from "@/lib/blob";
import { randomToken } from "@/lib/ids";
import { updateProfile } from "@/lib/workspace";

export const POST = route(async (req: Request) => {
  const user = await requireUser();
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Choose an image");
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new HttpError(400, "Use a JPEG, PNG or WebP image");
  if (file.size > 4 * 1024 ** 2) throw new HttpError(400, "Images must be under 4 MB");
  await deletePrefix(`avatars/${user.id}/`).catch(() => {});
  const pathname = avatarPath(user.id, randomToken(6));
  await putPrivate(pathname, Buffer.from(await file.arrayBuffer()), file.type);
  await updateProfile(user, { avatarPath: pathname });
  return Response.json({ avatarUrl: await viewUrl(pathname) });
});

export const DELETE = route(async () => {
  const user = await requireUser();
  await updateProfile(user, { avatarPath: null });
  await deletePrefix(`avatars/${user.id}/`).catch(() => {});
  return Response.json({ ok: true });
});
