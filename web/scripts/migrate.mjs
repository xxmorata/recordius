#!/usr/bin/env node
// Applies db/migrations/*.sql to DATABASE_URL. Usage: npm run db:migrate
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!url) {
  console.error("DATABASE_URL is not set (put it in .env.local or the environment).");
  process.exit(1);
}
const sql = postgres(url, { max: 1, prepare: false });
try {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set((await sql`select name from schema_migrations`).map((r) => r.name));
  const dir = join(process.cwd(), "db", "migrations");
  let count = 0;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727274)`;
    const done = new Set((await tx`select name from schema_migrations`).map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file) || applied.has(file) && done.has(file)) continue;
      await tx.unsafe(readFileSync(join(dir, file), "utf8"));
      await tx`insert into schema_migrations (name) values (${file})`;
      console.log(`applied ${file}`);
      count++;
    }
  });
  console.log(count ? `${count} migration(s) applied` : "database is up to date");
} finally {
  await sql.end();
}
