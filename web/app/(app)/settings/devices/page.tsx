import { DevicesList } from "./DevicesList";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";

export const metadata = { title: "Connected devices" };

export default async function DevicesPage() {
  const user = await requireUser();
  const rows = await sql()`select id, name, created_at, last_used_at from device_tokens where user_id = ${user.id} order by created_at desc`;
  const devices = rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    createdAt: new Date(r.created_at).getTime(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).getTime() : null,
  }));
  return <DevicesList initial={devices} />;
}
