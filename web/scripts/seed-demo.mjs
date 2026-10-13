#!/usr/bin/env node
// Dev helper: creates a demo workspace (if the database is empty) and a few real videos.
// Needs ffmpeg on PATH and a running server.   BASE=http://localhost:3000 node scripts/seed-demo.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { put } = require("@vercel/blob/client");

const BASE = process.env.BASE ?? "http://localhost:3000";
const EMAIL = process.env.DEMO_EMAIL ?? "demo@recordius.local";
const PASSWORD = process.env.DEMO_PASSWORD ?? "password1";

const jar = new Map();
async function call(method, path, body, bearer) {
  const headers = { "content-type": "application/json" };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(BASE + path, { method, headers, body: body && JSON.stringify(body) });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [k, v] = c.split(";")[0].split("=");
    jar.set(k.trim(), v);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

await fetch(`${BASE}/setup`);
let signedIn = await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD }).then(() => true).catch(() => false);
if (!signedIn) {
  await call("POST", "/api/auth/signup", { workspaceName: "Pixel & Co Design Studio", name: "Demo Designer", email: EMAIL, password: PASSWORD });
  console.log(`created workspace + ${EMAIL} / ${PASSWORD}`);
}
const { token } = await call("POST", "/api/desktop/connect", { deviceName: "Seed script" });

/** Uploads the video and its poster with whatever storage the server uses (vercel-blob, s3 or local). */
async function uploadFiles(created, video, jpeg, bearer) {
  const g = created.upload;
  if (g.provider === "vercel-blob") {
    await put(g.videoPathname, video, { access: "private", token: g.videoToken, contentType: "video/mp4", multipart: true });
    await put(g.thumbPathname, jpeg, { access: "private", token: g.thumbToken, contentType: "image/jpeg" });
    return;
  }
  const up = (body) => call("POST", `/api/videos/${created.id}/upload`, body, bearer);
  const { uploadId } = await up({ op: "create", file: "video" });
  const count = Math.max(1, Math.ceil(video.length / g.partSize));
  const { urls } = await up({ op: "parts", file: "video", uploadId, partNumbers: Array.from({ length: count }, (_, i) => i + 1) });
  const parts = [];
  for (let i = 0; i < count; i++) {
    const res = await fetch(urls[i + 1], { method: "PUT", body: video.subarray(i * g.partSize, (i + 1) * g.partSize) });
    if (!res.ok) throw new Error(`part ${i + 1} → ${res.status}`);
    parts.push({ partNumber: i + 1, etag: res.headers.get("etag") });
  }
  await up({ op: "complete", file: "video", uploadId, parts });
  const thumb = await up({ op: "put", file: "thumb" });
  const res = await fetch(thumb.url, { method: "PUT", body: jpeg, headers: { "content-type": thumb.contentType } });
  if (!res.ok) throw new Error(`thumbnail → ${res.status}`);
}

const dir = mkdtempSync(join(tmpdir(), "rcd-seed-"));
const VIDEOS = [
  { title: "Onboarding flow walkthrough — v3", seconds: 14, color: "0x625df5" },
  { title: "Bug repro: checkout button misaligned on mobile Safari", seconds: 6, color: "0xff4f52" },
  { title: "Weekly design review (long one, skip to 1:00 for the summary)", seconds: 95, color: "0x16a34a" },
];
for (const [i, v] of VIDEOS.entries()) {
  const mp4 = join(dir, `v${i}.mp4`);
  const jpg = join(dir, `v${i}.jpg`);
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${v.seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${v.seconds}`,
    "-vf", `drawbox=x=0:y=0:w=1280:h=90:color=${v.color}@0.9:t=fill`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", mp4,
  ]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "1", "-i", mp4, "-frames:v", "1", "-q:v", "3", jpg]);
  const created = await call("POST", "/api/videos", { title: v.title, mimeType: "video/mp4" }, token);
  await uploadFiles(created, readFileSync(mp4), readFileSync(jpg), token);
  await call("POST", `/api/videos/${created.id}/thumbnail`, undefined, token);
  await call("POST", `/api/videos/${created.id}/complete`, { durationMs: v.seconds * 1000, size: readFileSync(mp4).length }, token);
  if (i === 1) await call("PATCH", `/api/videos/${created.id}`, { privacy: "workspace" });
  if (i === 2) await call("PATCH", `/api/videos/${created.id}`, { privacy: "private" });
  console.log(`seeded ${created.shareUrl}`);
}
rmSync(dir, { recursive: true, force: true });
