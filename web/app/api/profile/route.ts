import { readJson, requireUser, route } from "@/lib/auth";
import { updateProfile } from "@/lib/workspace";

export const PATCH = route(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ name?: string }>(req);
  await updateProfile(user, { name: body.name });
  return Response.json({ ok: true });
});
