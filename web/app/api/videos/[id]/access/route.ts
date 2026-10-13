import { readJson, requireUser, route } from "@/lib/auth";
import { grantAccess, listAccess, revokeAccess } from "@/lib/videos";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  return Response.json({ emails: await listAccess((await params).id, await requireUser()) });
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  const body = await readJson<{ email?: string }>(req);
  const email = await grantAccess((await params).id, await requireUser(), String(body.email ?? ""));
  return Response.json({ email });
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const body = await readJson<{ email?: string }>(req);
  await revokeAccess((await params).id, await requireUser(), String(body.email ?? ""));
  return Response.json({ ok: true });
});
