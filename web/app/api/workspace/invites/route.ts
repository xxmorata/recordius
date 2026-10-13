import { readJson, requireUser, route } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { createInvite, listInvites } from "@/lib/workspace";

export const GET = route(async () => {
  return Response.json({ invites: await listInvites(await requireUser()) });
});

export const POST = route(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ role?: "admin" | "member"; expiresInDays?: number | null; maxUses?: number | null }>(req);
  const { id, token } = await createInvite(user, body);
  return Response.json({ id, url: `${appUrl(req)}/join/${token}` });
});
