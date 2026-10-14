import postgres, { type Sql } from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

declare global {
  // Reused across hot reloads in dev and across invocations in a warm serverless instance.
  var __recordiusSql: Sql | undefined;
}

export function sql(): Sql {
  if (!globalThis.__recordiusSql) {
    // Vercel's Neon/Postgres integrations expose several names; any pooled Postgres URL works.
    const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.POSTGRES_PRISMA_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    globalThis.__recordiusSql = postgres(url, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      // Works with transaction-mode poolers (Neon, Supabase, PgBouncer).
      prepare: false,
      transform: { undefined: null },
      // Postgres NOTICEs ("relation already exists, skipping") are informational; keep logs clean.
      onnotice: () => {},
    });
  }
  return globalThis.__recordiusSql;
}

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

/** Applies db/migrations/*.sql in order; safe to call repeatedly. */
export async function migrate(): Promise<string[]> {
  const db = sql();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  // Fast path: nothing to do (no lock, no writes).
  const ready = await db`select to_regclass('public.schema_migrations') as t`;
  if (ready[0]?.t) {
    const applied = new Set((await db`select name from schema_migrations`).map((r) => r.name as string));
    if (files.every((f) => applied.has(f))) return ran;
  }
  // Several server instances can boot at once: one applies migrations, the others wait for it. Even the
  // bookkeeping table is created under the lock (concurrent CREATE TABLE IF NOT EXISTS can fail in Postgres).
  await db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727274)`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx`select name from schema_migrations`).map((r) => r.name as string));
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      await tx`insert into schema_migrations (name) values (${file})`;
      ran.push(file);
    }
  });
  return ran;
}

/** True once the schema exists (used by /setup to decide whether to run migrations). */
declare global {
  var __recordiusSchemaReady: boolean | undefined;
}

export async function schemaReady(): Promise<boolean> {
  // Once the schema exists it doesn't go away while this server runs: remember it (one query saved per page).
  if (globalThis.__recordiusSchemaReady) return true;
  const rows = await sql()`select to_regclass('public.users') as t`;
  const ready = rows[0]?.t !== null;
  if (ready) globalThis.__recordiusSchemaReady = true;
  return ready;
}
