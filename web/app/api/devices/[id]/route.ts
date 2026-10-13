import { requireUser, route } from "@/lib/auth";
import { sql } from "@/lib/db";

export const DELETE = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  await sql()`delete from device_tokens where id = ${(await params).id} and user_id = ${user.id}`;
  return Response.json({ ok: true });
});
