import { readJson, requireUser, route, type Role } from "@/lib/auth";
import { removeMember, setMemberRole } from "@/lib/workspace";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const body = await readJson<{ role?: Role }>(req);
  await setMemberRole(await requireUser(), (await params).id, body.role as Role);
  return Response.json({ ok: true });
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  await removeMember(await requireUser(), (await params).id);
  return Response.json({ ok: true });
});
