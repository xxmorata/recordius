import { requireUser, route } from "@/lib/auth";
import { sql } from "@/lib/db";

export const GET = route(async () => {
  const user = await requireUser();
  const rows = await sql()`select id, name, created_at, last_used_at from device_tokens where user_id = ${user.id} order by created_at desc`;
  return Response.json({
    devices: rows.map((r) => ({ id: r.id, name: r.name, createdAt: new Date(r.created_at).getTime(), lastUsedAt: r.last_used_at ? new Date(r.last_used_at).getTime() : null })),
  });
});
