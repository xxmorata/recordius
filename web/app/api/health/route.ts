import { sql } from "@/lib/db";

/** For load balancers and the Docker healthcheck: is the database reachable? Reveals nothing else. */
export async function GET() {
  try {
    await sql()`select 1`;
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
