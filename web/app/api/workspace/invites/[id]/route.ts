import { requireUser, route } from "@/lib/auth";
import { revokeInvite } from "@/lib/workspace";

export const DELETE = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  await revokeInvite(await requireUser(), (await params).id);
  return Response.json({ ok: true });
});
