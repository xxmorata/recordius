#!/usr/bin/env node
// Adds seek indexes to every older recording in a workspace, now, instead of one by one as they're opened
// (recordings from desktop apps before 1.0.14 can't be seeked in Firefox until then).
//   BASE=https://videos.example.com node scripts/reindex.mjs
// Asks for a workspace owner's or admin's email and password (or reads RECORDIUS_EMAIL / RECORDIUS_PASSWORD).
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const BASE = (process.env.BASE ?? "http://localhost:3000").replace(/\/$/, "");
const rl = createInterface({ input: stdin, output: stdout });
const email = process.env.RECORDIUS_EMAIL || (await rl.question(`Email of a workspace owner/admin on ${BASE}: `));
let password = process.env.RECORDIUS_PASSWORD;
if (!password) {
  stdout.write("Password: ");
  password = await new Promise((resolve) => {
    let typed = "";
    const onData = (c) => {
      const ch = String(c);
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        stdin.setRawMode?.(false);
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolve(typed);
      } else if (ch === "\u0003") process.exit(1);
      else if (ch === "\u007f") typed = typed.slice(0, -1);
      else typed += ch;
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
rl.close();

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password }) });
if (!login.ok) {
  console.error(`Sign-in failed (${login.status}): ${(await login.json().catch(() => ({}))).error ?? ""}`);
  process.exit(1);
}
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
let total = { processed: 0, ready: 0, failed: 0 };
for (;;) {
  const res = await fetch(`${BASE}/api/videos/reindex`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: BASE }, body: JSON.stringify({ limit: 20 }) });
  const r = await res.json();
  if (!res.ok) {
    console.error(`Failed (${res.status}): ${r.error ?? ""}`);
    process.exit(1);
  }
  total = { processed: total.processed + r.processed, ready: total.ready + r.ready, failed: total.failed + r.failed };
  console.log(`processed ${r.processed} (ready ${r.ready}, failed ${r.failed}, busy ${r.busy}), ${r.remaining} remaining`);
  if (!r.remaining || !r.processed) break;
}
console.log(`Done: ${total.ready} repaired or already fine, ${total.failed} failed (they're logged on the server).`);
