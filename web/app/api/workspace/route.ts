import { readJson, requireUser, route } from "@/lib/auth";
import { updateWorkspace } from "@/lib/workspace";
import type { Privacy } from "@/lib/videos";

export const PATCH = route(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ name?: string; defaultPrivacy?: Privacy }>(req);
  await updateWorkspace(user, body);
  return Response.json({ ok: true });
});
