#!/usr/bin/env node
// End-to-end API test against a running server. Needs BLOB_READ_WRITE_TOKEN (uploads are real) and a scratch database.
//   BASE=http://localhost:3000 node scripts/test-api.mjs
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { createMultipartUpload, uploadPart, completeMultipartUpload, put } = require("@vercel/blob/client");

const BASE = process.env.BASE ?? "http://localhost:3000";
const stamp = Date.now();
let passed = 0;

function section(name) {
  console.log(`\n▸ ${name}`);
}
function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

/** Minimal cookie-jar client. */
function client() {
  const jar = new Map();
  let bearer = null;
  async function call(method, path, body, extra = {}) {
    const headers = { ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...extra.headers };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = pair.split("=");
      if (attrs.some((a) => /max-age=0/i.test(a))) jar.delete(k.trim());
      else jar.set(k.trim(), v);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
  return { call, setBearer: (t) => (bearer = t), jar };
}

// ───────── uploads, whatever storage the server uses (the same two paths as the desktop app) ─────────

async function uploadVideoParts(c, video, buffers) {
  const g = video.upload;
  if (g.provider === "vercel-blob") {
    const opts = { access: "private", token: g.videoToken, contentType: "video/mp4" };
    const mpu = await createMultipartUpload(g.videoPathname, opts);
    const parts = [];
    for (let i = 0; i < buffers.length; i++) parts.push(await uploadPart(g.videoPathname, buffers[i], { ...opts, uploadId: mpu.uploadId, key: mpu.key, partNumber: i + 1 }));
    await completeMultipartUpload(g.videoPathname, parts, { ...opts, uploadId: mpu.uploadId, key: mpu.key });
    return;
  }
  const api = (body) => c.call("POST", `/api/videos/${video.id}/upload`, body);
  const created = await api({ op: "create", file: "video" });
  assert.equal(created.status, 200, `create upload: ${created.text}`);
  const { uploadId } = created.json;
  const { urls } = (await api({ op: "parts", file: "video", uploadId, partNumbers: buffers.map((_, i) => i + 1) })).json;
  const parts = [];
  for (let i = 0; i < buffers.length; i++) {
    const res = await fetch(urls[i + 1], { method: "PUT", body: buffers[i] });
    assert.equal(res.status, 200, `part ${i + 1}: ${res.status} ${await res.clone().text()}`);
    parts.push({ partNumber: i + 1, etag: res.headers.get("etag") });
  }
  const done = await api({ op: "complete", file: "video", uploadId, parts });
  assert.equal(done.status, 200, `complete upload: ${done.text}`);
}

async function uploadThumb(c, video, jpeg) {
  const g = video.upload;
  if (g.provider === "vercel-blob") return put(g.thumbPathname, jpeg, { access: "private", token: g.thumbToken, contentType: "image/jpeg" });
  const r = await c.call("POST", `/api/videos/${video.id}/upload`, { op: "put", file: "thumb" });
  assert.equal(r.status, 200, r.text);
  const res = await fetch(r.json.url, { method: "PUT", body: jpeg, headers: { "content-type": r.json.contentType } });
  assert.equal(res.status, 200, `thumbnail PUT ${res.status}`);
}

async function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${res.text.slice(0, 200)}`);
  ok(label);
}

const owner = client();
const member = client();
const outsider = client();
const invitee = client();
const anon = client();
const desktop = client();

section("setup & auth");
let r = await owner.call("GET", "/");
assert.ok([307, 308].includes(r.status) && r.headers.get("location").endsWith("/setup"), "fresh install redirects to /setup");
ok("fresh install redirects to /setup");
r = await owner.call("GET", "/setup");
await expectStatus(r, 200, "/setup renders (runs migrations)");
r = await owner.call("POST", "/api/auth/signup", { workspaceName: "Test Studio", name: "Olivia Owner", email: `owner${stamp}@test.dev`, password: "password1" });
await expectStatus(r, 200, "first signup creates workspace");
r = await outsider.call("POST", "/api/auth/signup", { workspaceName: "X", name: "O", email: `o${stamp}@test.dev`, password: "password1" });
await expectStatus(r, 403, "open signup is closed by default");
r = await owner.call("GET", "/api/me");
await expectStatus(r, 200, "session works");
assert.equal(r.json.role, "owner");
assert.equal(r.json.workspace.name, "Test Studio");
r = await anon.call("GET", "/api/me");
await expectStatus(r, 401, "anonymous is rejected");
r = await anon.call("POST", "/api/auth/login", { email: `owner${stamp}@test.dev`, password: "wrong" });
await expectStatus(r, 401, "wrong password");

section("invites & members");
r = await owner.call("POST", "/api/workspace/invites", { role: "member", expiresInDays: 14 });
await expectStatus(r, 200, "owner creates invite");
const inviteToken = r.json.url.split("/join/")[1];
r = await anon.call("GET", `/api/invites/${inviteToken}`);
await expectStatus(r, 200, "invite preview");
assert.equal(r.json.workspaceName, "Test Studio");
r = await member.call("POST", `/api/invites/${inviteToken}`, { name: "Max Member", email: `member${stamp}@test.dev`, password: "password1" });
await expectStatus(r, 200, "member joins via invite");
r = await invitee.call("POST", `/api/invites/${inviteToken}`, { name: "Ivy Invitee", email: `ivy${stamp}@test.dev`, password: "password1" });
await expectStatus(r, 200, "second member joins via same invite");
r = await anon.call("GET", "/api/invites/not-a-token");
await expectStatus(r, 404, "bogus invite rejected");
r = await member.call("POST", "/api/workspace/invites", { role: "member" });
await expectStatus(r, 403, "member can't create invites");
r = await owner.call("GET", "/api/workspace/members");
assert.equal(r.json.members.length, 3);
ok("3 members listed");
const memberId = r.json.members.find((m) => m.email === `member${stamp}@test.dev`).id;
const ivyId = r.json.members.find((m) => m.email === `ivy${stamp}@test.dev`).id;
r = await owner.call("PATCH", `/api/workspace/members/${memberId}`, { role: "admin" });
await expectStatus(r, 200, "owner promotes member to admin");
r = await member.call("PATCH", `/api/workspace/members/${ivyId}`, { role: "admin" });
await expectStatus(r, 200, "admin can promote");
r = await member.call("PATCH", `/api/workspace/members/${ivyId}`, { role: "member" });
await expectStatus(r, 403, "admin can't demote another admin");
r = await owner.call("PATCH", `/api/workspace/members/${ivyId}`, { role: "member" });
await expectStatus(r, 200, "owner demotes");
r = await owner.call("PATCH", "/api/workspace", { name: "Test Studio Renamed", defaultPrivacy: "workspace" });
await expectStatus(r, 200, "workspace settings saved");

section("desktop connect");
r = await owner.call("POST", "/api/desktop/connect", { deviceName: "Test Mac" });
await expectStatus(r, 200, "device token issued");
assert.ok(r.json.deepLink.startsWith("recordius://connect?"));
desktop.setBearer(r.json.token);
r = await desktop.call("GET", "/api/me");
await expectStatus(r, 200, "device token authenticates");
assert.equal(r.json.user.email, `owner${stamp}@test.dev`);
r = await owner.call("GET", "/api/devices");
assert.equal(r.json.devices.length, 1);
ok("device listed");
r = await desktop.call("POST", "/api/desktop/connect", { deviceName: "nope" });
await expectStatus(r, 403, "device token can't mint device tokens");

section("recording flow (real upload to the configured storage)");
r = await desktop.call("POST", "/api/videos", { title: "API smoke test", mimeType: "video/mp4" });
await expectStatus(r, 200, "recording session created");
const video = r.json;
assert.equal(video.privacy, "workspace", "inherits workspace default privacy");
assert.ok(video.shareUrl.endsWith(`/share/${video.id}`));
assert.equal(video.upload.access, "private");
r = await anon.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 401, "workspace video needs sign-in");
r = await member.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 200, "member sees it while recording");
assert.equal(r.json.status, "recording");
assert.equal(r.json.videoUrl, null);
console.log(`  (storage: ${video.upload.provider})`);
const p = video.upload.videoPathname;
const partA = Buffer.alloc(video.upload.partSize ?? 5 * 1024 * 1024, 1);
const partB = Buffer.from("tail");
r = await desktop.call("POST", `/api/videos/${video.id}/complete`, { durationMs: 4200, size: 10 });
await expectStatus(r, 409, "can't complete before the file is uploaded");
await uploadVideoParts(desktop, video, [partA, partB]);
ok("multipart upload (2 parts)");
await uploadThumb(desktop, video, Buffer.from("fakejpeg"));
r = await desktop.call("POST", `/api/videos/${video.id}/thumbnail`);
await expectStatus(r, 200, "thumbnail marked");
if (video.upload.provider === "vercel-blob") {
  await assert.rejects(() => createMultipartUpload(`videos/${video.id}/evil.mp4`, { access: "private", token: video.upload.videoToken }), "scoped token can't write elsewhere");
  ok("scoped token can't write elsewhere");
} else {
  r = await member.call("POST", `/api/videos/${video.id}/upload`, { op: "create", file: "video" });
  await expectStatus(r, 403, "others can't get upload URLs");
  r = await anon.call("POST", `/api/videos/${video.id}/upload`, { op: "create", file: "video" });
  await expectStatus(r, 401, "anonymous can't get upload URLs");
  r = await desktop.call("POST", `/api/videos/${video.id}/upload`, { op: "create", file: "../../etc/passwd" });
  await expectStatus(r, 400, "only the video's own files can be uploaded");
  r = await desktop.call("POST", `/api/videos/${video.id}/upload`, { op: "put", file: "video" });
  await expectStatus(r, 400, "videos can't skip the multipart path");
  r = await desktop.call("POST", `/api/videos/${video.id}/upload`, { op: "parts", file: "video", uploadId: "x", partNumbers: [0] });
  await expectStatus(r, 400, "part numbers are validated");
  // a signed URL can't be bent to another part or file
  const { uploadId } = (await desktop.call("POST", `/api/videos/${video.id}/upload`, { op: "create", file: "video" })).json;
  const { urls } = (await desktop.call("POST", `/api/videos/${video.id}/upload`, { op: "parts", file: "video", uploadId, partNumbers: [1] })).json;
  const forged = urls[1].replace(/([?&](?:n|partNumber|PartNumber)=)1(&|$)/, "$12$2");
  assert.notEqual(forged, urls[1]);
  const forgedRes = await fetch(forged, { method: "PUT", body: "x" });
  assert.equal(forgedRes.status, 403, `forged part URL → ${forgedRes.status}`);
  ok("tampered upload URL is refused");
  if (video.upload.provider === "local") {
    const sig = new URL(urls[1]).searchParams.get("s");
    const expired = urls[1].replace(/([?&]e=)\d+/, "$11000");
    assert.equal((await fetch(expired, { method: "PUT", body: "x" })).status, 403);
    assert.ok(sig);
    ok("expired upload URL is refused");
  }
}
r = await desktop.call("POST", `/api/videos/${video.id}/complete`, { durationMs: 4200, size: partA.length + partB.length });
await expectStatus(r, 200, "complete");
r = await member.call("GET", `/api/videos/${video.id}`);
assert.equal(r.json.status, "ready");
assert.ok(r.json.videoUrl && r.json.thumbUrl && r.json.downloadUrl, "urls present for member");
ok("member gets presigned urls");
const bytes = await fetch(r.json.videoUrl);
assert.equal(bytes.status, 200);
assert.equal(Number(bytes.headers.get("content-length")), partA.length + partB.length);
ok("presigned video url serves the file");
const ranged = await fetch(r.json.videoUrl, { headers: { range: `bytes=${partA.length}-` } });
assert.equal(ranged.status, 206);
assert.equal(await ranged.text(), "tail");
ok("range requests work (seeking)");
const plain = await fetch(r.json.videoUrl.split("?")[0]);
assert.ok([400, 401, 403, 404].includes(plain.status), `unsigned URL → ${plain.status}`);
ok("the file is private without a signed URL");
{
  const u = new URL(r.json.videoUrl);
  for (const k of ["e", "X-Amz-Expires"]) if (u.searchParams.has(k)) u.searchParams.set(k, k === "e" ? String(Date.now() + 10 ** 10) : "604800");
  if (u.toString() !== r.json.videoUrl) {
    assert.equal((await fetch(u)).status, 403);
    ok("extending a signed URL's lifetime breaks the signature");
  }
}
const dl = await fetch(r.json.downloadUrl, { method: "GET", headers: { range: "bytes=0-0" } });
assert.ok([200, 206].includes(dl.status));
if (video.upload.provider !== "vercel-blob") assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
ok("download URL works");

section("privacy rules");
r = await owner.call("GET", "/api/workspace/members");
const memberRole = r.json.members.find((m) => m.id === memberId).role;
assert.equal(memberRole, "admin");
r = await member.call("PATCH", `/api/videos/${video.id}`, { privacy: "link" });
await expectStatus(r, 200, "admin can edit any workspace video");
r = await owner.call("PATCH", `/api/workspace/members/${memberId}`, { role: "member" });
await expectStatus(r, 200, "demote helper back to member");
r = await member.call("PATCH", `/api/videos/${video.id}`, { title: "hacked" });
await expectStatus(r, 403, "plain member can't edit someone else's video");
r = await anon.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 200, "link privacy: anonymous can watch");
assert.equal(r.json.access, "link");
assert.ok(r.json.videoUrl);
r = await anon.call("GET", `/share/${video.id}`);
await expectStatus(r, 200, "share page renders for anonymous");
assert.ok(r.text.includes("API smoke test"));
r = await anon.call("POST", `/api/videos/${video.id}/view`);
await expectStatus(r, 200, "view counted");
r = await desktop.call("GET", `/api/videos/${video.id}`);
assert.equal(r.json.views, 1);
ok("view count = 1");
r = await owner.call("POST", `/api/videos/${video.id}/view`);
r = await owner.call("GET", `/api/videos/${video.id}`);
assert.equal(r.json.views, 1);
ok("owner views aren't counted");

r = await owner.call("PATCH", `/api/videos/${video.id}`, { privacy: "private" });
await expectStatus(r, 200, "set private");
r = await member.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 403, "private: member blocked");
r = await anon.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 401, "private: anonymous blocked");
r = await anon.call("GET", `/share/${video.id}`);
assert.ok([307, 308].includes(r.status) && r.headers.get("location").includes("/login"), "share page redirects anon to login");
ok("share page redirects anonymous to sign in");
r = await member.call("GET", `/share/${video.id}`);
await expectStatus(r, 200, "share page shows 'private' screen to member");
assert.ok(r.text.includes("This video is private"));
r = await owner.call("POST", `/api/videos/${video.id}/access`, { email: `IVY${stamp}@test.dev` });
await expectStatus(r, 200, "invite by email (case-insensitive)");
r = await invitee.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 200, "invited person can watch");
assert.equal(r.json.access, "invited");
r = await invitee.call("GET", "/api/videos?scope=workspace");
assert.ok(r.json.videos.some((v) => v.id === video.id));
ok("invited video appears in invitee's workspace list");
r = await owner.call("GET", `/api/videos/${video.id}/access`);
assert.deepEqual(r.json.emails, [`ivy${stamp}@test.dev`]);
ok("access list");
r = await owner.call("DELETE", `/api/videos/${video.id}/access`, { email: `ivy${stamp}@test.dev` });
r = await invitee.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 403, "revoked invitee blocked");
r = await owner.call("GET", `/embed/${video.id}`);
await expectStatus(r, 200, "embed page for owner");

section("trim, protected links, viewers, thumbnails");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { privacy: "link" });
r = await owner.call("PATCH", `/api/videos/${video.id}`, { trim: { startMs: 1000, endMs: 1500 } });
await expectStatus(r, 400, "trim shorter than 1 s rejected");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { trim: { startMs: 500, endMs: 9000 } });
await expectStatus(r, 400, "trim past the end rejected");
r = await member.call("PATCH", `/api/videos/${video.id}`, { trim: { startMs: 0, endMs: 2000 } });
await expectStatus(r, 403, "member can't trim someone else's video");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { trim: { startMs: 1000, endMs: 3500 } });
await expectStatus(r, 200, "trim saved");
r = await anon.call("GET", `/api/videos/${video.id}`);
assert.deepEqual(r.json.trim, { startMs: 1000, endMs: 3500 });
assert.equal(r.json.durationMs, 2500);
assert.equal(r.json.originalDurationMs, 4200);
ok("viewers get the trimmed length");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { trim: { startMs: 0, endMs: 4200 } });
r = await anon.call("GET", `/api/videos/${video.id}`);
assert.equal(r.json.trim, null);
ok("full-length trim is stored as no trim");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { trim: { startMs: 1000, endMs: 3500 } });

// watch progress & unique viewers
const watcherA = client();
const watcherB = client();
r = await watcherA.call("POST", `/api/videos/${video.id}/view`, { positionMs: 0 });
await expectStatus(r, 200, "anonymous view recorded");
await watcherA.call("POST", `/api/videos/${video.id}/view`, { positionMs: 2000 });
await watcherA.call("POST", `/api/videos/${video.id}/view`, { positionMs: 500 }); // going back doesn't lower progress
await watcherB.call("POST", `/api/videos/${video.id}/view`, { positionMs: 1250 });
await member.call("POST", `/api/videos/${video.id}/view`, { positionMs: 2500 });
r = await owner.call("GET", `/api/videos/${video.id}/viewers`);
await expectStatus(r, 200, "owner sees viewers");
// 4 = the anonymous viewer from the privacy section (stopped at 0%) + watcherA + watcherB + member
assert.equal(r.json.total, 4, "4 distinct viewers");
assert.equal(r.json.viewers.length, 1);
assert.equal(r.json.viewers[0].email, `member${stamp}@test.dev`);
assert.equal(r.json.viewers[0].percent, 100);
assert.equal(r.json.anonymous.count, 3);
assert.equal(r.json.anonymous.avgPercent, 43, "avg of 0%, 80% and 50%");
ok("progress per viewer (max position, trimmed timeline)");
r = await owner.call("GET", `/api/videos/${video.id}`);
const viewsBefore = r.json.views;
await watcherA.call("POST", `/api/videos/${video.id}/view`, { positionMs: 2400 });
r = await owner.call("GET", `/api/videos/${video.id}`);
assert.equal(r.json.views, viewsBefore, "repeat reports don't add views");
ok("views count unique viewers");
// trimmed video: viewers don't get the uncut file for download, the owner does
r = await anon.call("GET", `/api/videos/${video.id}`);
assert.equal(r.json.downloadUrl, null);
r = await owner.call("GET", `/api/videos/${video.id}`);
assert.ok(r.json.downloadUrl);
ok("trimmed videos aren't downloadable by viewers");

r = await member.call("GET", `/api/videos/${video.id}/viewers`);
await expectStatus(r, 403, "member can't see viewer list");

// password-protected link
r = await owner.call("PATCH", `/api/videos/${video.id}`, { linkPassword: "abcde" });
await expectStatus(r, 400, "too-short password rejected");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { linkPassword: "open sesame" });
await expectStatus(r, 200, "password set");
const guest = client();
r = await guest.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 401, "password needed");
assert.ok(!JSON.stringify(r.json).includes("blob"), "no urls leak before unlocking");
r = await guest.call("GET", `/share/${video.id}`);
await expectStatus(r, 200, "share page shows the password screen");
assert.ok(r.text.includes("password protected") && !r.text.includes("Renamed") && !r.text.includes("API smoke test"));
r = await guest.call("POST", `/api/videos/${video.id}/unlock`, { password: "nope" });
await expectStatus(r, 403, "wrong password");
r = await guest.call("POST", `/api/videos/${video.id}/unlock`, { password: "open sesame" });
await expectStatus(r, 200, "right password");
r = await guest.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 200, "unlocked guest can watch");
assert.ok(r.json.videoUrl);
r = await member.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 200, "workspace members skip the password");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { linkPassword: "another one" });
r = await guest.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 401, "changing the password re-locks");
// brute force: 8 wrong attempts from one client, then 429 even with the right password
for (let i = 0; i < 8; i++) await guest.call("POST", `/api/videos/${video.id}/unlock`, { password: `guess${i}` }, { headers: { "x-forwarded-for": "203.0.113.7" } });
r = await guest.call("POST", `/api/videos/${video.id}/unlock`, { password: "another one" }, { headers: { "x-forwarded-for": "203.0.113.7" } });
await expectStatus(r, 429, "password guessing is rate limited");
r = await guest.call("POST", `/api/videos/${video.id}/unlock`, { password: "another one" }, { headers: { "x-forwarded-for": "198.51.100.9" } });
await expectStatus(r, 200, "other clients aren't locked out");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { linkPassword: null });
r = await guest.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 200, "removing the password opens it");
assert.equal(r.json.link.hasPassword, false);

// expiring link
r = await owner.call("PATCH", `/api/videos/${video.id}`, { linkExpiresAt: Date.now() - 1000 });
await expectStatus(r, 400, "expiry in the past rejected");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { linkExpiresAt: Date.now() + 1500 });
await expectStatus(r, 200, "expiry set");
r = await guest.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 200, "works before expiry");
await new Promise((res) => setTimeout(res, 2000));
r = await guest.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 410, "expired link refused");
r = await guest.call("GET", `/share/${video.id}`);
assert.ok(r.text.includes("This link has expired"));
ok("share page explains the expiry");
r = await member.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 200, "members still see an expired-link video");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { linkExpiresAt: null });
r = await guest.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 200, "expiry removed");

// custom thumbnail
{
  const fd = new FormData();
  fd.set("file", new File([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9])], "t.jpg", { type: "image/jpeg" }));
  r = await owner.call("POST", `/api/videos/${video.id}/thumbnail`, fd);
  await expectStatus(r, 200, "custom thumbnail saved");
  // the stored file name, whether the signed URL carries it in its path (blob, S3) or a query (local storage)
  const fileOf = (url) => new URL(url).searchParams.get("p") ?? new URL(url).pathname;
  const first = fileOf(r.json.thumbUrl);
  assert.ok(/thumb-[\w-]+\.jpg$/.test(first));
  const fd2 = new FormData();
  fd2.set("file", new File([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7])], "t.jpg", { type: "image/jpeg" }));
  r = await owner.call("POST", `/api/videos/${video.id}/thumbnail`, fd2);
  const second = fileOf(r.json.thumbUrl);
  assert.notEqual(second, first, "new file name, so caches can't serve the old one");
  r = await guest.call("GET", `/api/videos/${video.id}`);
  assert.equal(fileOf(r.json.thumbUrl), second);
  assert.equal((await fetch(r.json.thumbUrl)).status, 200);
  ok("viewers get the custom thumbnail");
  const fd3 = new FormData();
  fd3.set("file", new File([Buffer.from("x")], "t.png", { type: "image/png" }));
  r = await owner.call("POST", `/api/videos/${video.id}/thumbnail`, fd3);
  await expectStatus(r, 400, "non-JPEG thumbnail rejected");
  r = await member.call("POST", `/api/videos/${video.id}/thumbnail`, fd);
  await expectStatus(r, 403, "member can't change the thumbnail");
}

// browser upload flow (same as the library's drag & drop)
{
  r = await owner.call("POST", "/api/videos", { title: "uploaded.mov", mimeType: "video/mp4", source: "upload" });
  await expectStatus(r, 200, "upload session created");
  const up = r.json;
  r = await owner.call("GET", `/api/videos/${up.id}`);
  assert.equal(r.json.source, "upload");
  await uploadVideoParts(owner, up, [Buffer.alloc(1024, 3)]);
  r = await owner.call("POST", `/api/videos/${up.id}/complete`, { durationMs: 3000, size: 1024 });
  await expectStatus(r, 200, "uploaded file completed");
  r = await owner.call("GET", "/api/videos?scope=mine&limit=1");
  assert.equal(r.json.videos.length, 1);
  assert.equal(r.json.videos[0].id, up.id, "newest first, limit respected");
  ok("recent list with limit (desktop app)");
  await owner.call("DELETE", `/api/videos/${up.id}`);
}

section("comments, oEmbed, re-upload, rate-limit edge cases");
// comments: workspace people only
r = await anon.call("GET", `/api/videos/${video.id}/comments`);
await expectStatus(r, 401, "anonymous can't read comments");
r = await anon.call("POST", `/api/videos/${video.id}/comments`, { body: "spam" });
await expectStatus(r, 401, "anonymous can't comment");
r = await member.call("POST", `/api/videos/${video.id}/comments`, { body: "Nice intro", atMs: 1200 });
await expectStatus(r, 200, "member comments at a timestamp");
const memberComment = r.json.id;
r = await owner.call("POST", `/api/videos/${video.id}/comments`, { body: "General note" });
await expectStatus(r, 200, "owner adds a general comment");
const ownerComment = r.json.id;
r = await owner.call("POST", `/api/videos/${video.id}/comments`, { body: "Way past the end", atMs: 99999999 });
await expectStatus(r, 200, "timestamp past the end is accepted");
r = await owner.call("POST", `/api/videos/${video.id}/comments`, { body: "   " });
await expectStatus(r, 400, "empty comment rejected");
r = await owner.call("POST", `/api/videos/${video.id}/comments`, { body: "x".repeat(4001) });
await expectStatus(r, 400, "over-long comment rejected");
r = await member.call("GET", `/api/videos/${video.id}/comments`);
await expectStatus(r, 200, "member reads comments");
{
  const list = r.json.comments;
  assert.equal(list.length, 3);
  assert.equal(list[0].body, "Nice intro");
  assert.equal(list[0].atMs, 1200);
  assert.ok(list[1].atMs <= 4200 && list[1].atMs > 1200, "clamped to the video length");
  assert.equal(list[2].atMs, null, "general comments come last");
  assert.equal(list[0].canDelete, true);
  assert.equal(list[2].canDelete, false);
  assert.ok(!("email" in list[0].author), "no emails in comments");
  ok("ordered by timestamp, clamped, own comments deletable");
}
r = await member.call("DELETE", `/api/videos/${video.id}/comments/${ownerComment}`);
await expectStatus(r, 403, "member can't delete someone else's comment");
r = await owner.call("DELETE", `/api/videos/${video.id}/comments/${memberComment}`);
await expectStatus(r, 200, "video owner can delete any comment");
r = await owner.call("DELETE", `/api/videos/${video.id}/comments/${memberComment}`);
await expectStatus(r, 404, "deleting twice is a 404");
r = await owner.call("DELETE", `/api/videos/${video.id}/comments/not-a-uuid`);
await expectStatus(r, 404, "malformed comment id is a 404, not a 500");
r = await owner.call("POST", `/api/videos/${video.id}/comments`, null);
await expectStatus(r, 400, "null JSON body is a 400");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { privacy: "private" });
r = await member.call("GET", `/api/videos/${video.id}/comments`);
await expectStatus(r, 403, "losing access hides comments");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { privacy: "link" });
r = await owner.call("GET", `/api/videos/${"0".repeat(32)}/comments`);
await expectStatus(r, 404, "comments on a missing video");

// oEmbed + stable poster: only for videos anyone can watch
const shareLink = `${BASE}/share/${video.id}`;
r = await anon.call("GET", `/api/oembed?url=${encodeURIComponent(shareLink)}&maxwidth=640`);
await expectStatus(r, 200, "oEmbed for a public link");
assert.equal(r.json.type, "video");
assert.equal(r.json.width, 640);
assert.equal(r.json.height, 360);
assert.ok(r.json.html.includes(`/embed/${video.id}`));
assert.ok(r.json.thumbnail_url.endsWith(`/api/videos/${video.id}/poster`));
ok("oEmbed returns an iframe and a stable thumbnail");
r = await anon.call("GET", `/api/videos/${video.id}/poster`);
assert.equal(r.status, 302);
assert.equal((await fetch(r.headers.get("location"))).status, 200);
ok("poster redirects to a working signed URL");
r = await anon.call("GET", `/share/${video.id}`);
assert.ok(r.text.includes("application/json+oembed"));
assert.ok(r.text.includes(`/api/videos/${video.id}/poster`));
ok("share page advertises oEmbed and the stable poster");
r = await anon.call("GET", `/api/oembed?url=${encodeURIComponent(`https://evil.example/share/${video.id}`)}`);
await expectStatus(r, 404, "oEmbed ignores other sites");
r = await anon.call("GET", `/api/oembed?url=${encodeURIComponent(shareLink)}&format=xml`);
await expectStatus(r, 501, "oEmbed XML not supported");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { linkPassword: "secret words" });
r = await anon.call("GET", `/api/oembed?url=${encodeURIComponent(shareLink)}`);
await expectStatus(r, 404, "no oEmbed for password-protected links");
r = await anon.call("GET", `/api/videos/${video.id}/poster`);
await expectStatus(r, 404, "no poster for password-protected links");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { linkPassword: null, privacy: "workspace" });
r = await anon.call("GET", `/api/oembed?url=${encodeURIComponent(shareLink)}`);
await expectStatus(r, 404, "no oEmbed for workspace-only videos");
r = await owner.call("GET", `/share/${video.id}`);
assert.ok(!r.text.includes("application/json+oembed"));
ok("workspace-only share page has no oEmbed link");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { privacy: "link" });

// re-upload tokens for the desktop app's retry
r = await desktop.call("POST", `/api/videos/${video.id}/upload-token`);
await expectStatus(r, 409, "no re-upload for a finished video");
r = await anon.call("POST", `/api/videos/${video.id}/upload-token`);
await expectStatus(r, 401, "re-upload needs sign-in");
{
  const fresh = (await desktop.call("POST", "/api/videos", { title: "Retry me", mimeType: "video/mp4" })).json;
  r = await member.call("POST", `/api/videos/${fresh.id}/upload-token`);
  await expectStatus(r, 403, "others can't get upload tokens");
  r = await desktop.call("POST", `/api/videos/${fresh.id}/upload-token`);
  await expectStatus(r, 200, "owner gets fresh upload tokens");
  const up = r.json.upload;
  assert.equal(up.videoPathname, fresh.upload.videoPathname, "same file as before");
  await uploadVideoParts(desktop, { id: fresh.id, upload: up }, [Buffer.alloc(1024, 7)]);
  ok("upload with the reissued token");
  r = await desktop.call("POST", `/api/videos/${fresh.id}/complete`, { durationMs: 2000, size: 1024 });
  await expectStatus(r, 200, "complete after retry");
  r = await desktop.call("POST", `/api/videos/${fresh.id}/upload-token`);
  await expectStatus(r, 409, "finished after retry → 409 (the app drops it from its queue)");
  assert.equal(r.json.code, "already_uploaded");
  await owner.call("DELETE", `/api/videos/${fresh.id}`);
  r = await desktop.call("POST", `/api/videos/${fresh.id}/upload-token`);
  await expectStatus(r, 404, "deleted video → 404 (the app drops it from its queue)");
  assert.equal(r.json.code, "video_gone");
  ok("machine-readable codes for the desktop queue");
}

// rate limit: blocked attempts don't count toward the per-video cap; IPv4-mapped IPv6 = same client
r = await owner.call("PATCH", `/api/videos/${video.id}`, { linkPassword: "cap test pw" });
{
  const hammer = client();
  for (let i = 0; i < 8; i++) await hammer.call("POST", `/api/videos/${video.id}/unlock`, { password: `nope${i}` }, { headers: { "x-forwarded-for": "192.0.2.50" } });
  r = await hammer.call("POST", `/api/videos/${video.id}/unlock`, { password: "nope" }, { headers: { "x-forwarded-for": "::ffff:192.0.2.50" } });
  await expectStatus(r, 429, "IPv4-mapped IPv6 address counts as the same client");
  const blocked = [];
  for (let i = 0; i < 16; i++) {
    blocked.push(...(await Promise.all(Array.from({ length: 20 }, () => hammer.call("POST", `/api/videos/${video.id}/unlock`, { password: "nope" }, { headers: { "x-forwarded-for": "192.0.2.50" } })))));
  }
  assert.ok(blocked.every((b) => b.status === 429));
  ok("320 more attempts from a blocked client are all refused");
  const viewer = client();
  r = await viewer.call("POST", `/api/videos/${video.id}/unlock`, { password: "cap test pw" }, { headers: { "x-forwarded-for": "198.51.100.77" } });
  await expectStatus(r, 200, "a blocked client's attempts don't lock out a real viewer");
  const burst = await Promise.all(Array.from({ length: 15 }, (_, i) => client().call("POST", `/api/videos/${video.id}/unlock`, { password: `x${i}` }, { headers: { "x-forwarded-for": "198.51.100.200" } })));
  const tally = burst.reduce((t, b) => ({ ...t, [b.status]: (t[b.status] ?? 0) + 1 }), {});
  assert.deepEqual(tally, { 403: 8, 429: 7 }, `parallel unlock burst: ${JSON.stringify(tally)}`);
  ok("15 parallel password guesses: exactly 8 are checked");
}
r = await owner.call("PATCH", `/api/videos/${video.id}`, { linkPassword: null });

section("abuse protection");
r = await anon.call("POST", "/api/auth/login", { email: `owner${stamp}@test.dev`, password: "password1" }, { headers: { origin: "https://evil.example" } });
await expectStatus(r, 403, "cross-site POST refused (CSRF)");
{
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ email: "x@y.z", password: "p" }) });
  assert.equal(res.status, 415);
  ok("form-style (text/plain) bodies refused");
}
r = await owner.call("PATCH", `/api/videos/${video.id}`, { title: "API smoke test" }, { headers: { origin: BASE } });
await expectStatus(r, 200, "same-site POST with Origin allowed");
{
  const guesser = client();
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await guesser.call("POST", "/api/auth/login", { email: `nobody${stamp}@test.dev`, password: `guess${i}` })).status);
  assert.deepEqual(codes, [...Array(10).fill(401), 429]);
  ok("sign-in guessing is limited per account (10 per 15 min)");
  const burst = await Promise.all(Array.from({ length: 25 }, (_, i) => client().call("POST", "/api/auth/login", { email: `burst${stamp}@test.dev`, password: `p${i}` })));
  const tally = burst.reduce((t, b) => ({ ...t, [b.status]: (t[b.status] ?? 0) + 1 }), {});
  assert.deepEqual(tally, { 401: 10, 429: 15 }, `parallel burst: ${JSON.stringify(tally)}`);
  ok("25 parallel guesses: exactly 10 get through to the password check");
  const fine = client();
  await expectStatus(await fine.call("POST", "/api/auth/login", { email: `owner${stamp}@test.dev`, password: "password1" }), 200, "other accounts can still sign in");
}
r = await owner.call("POST", `/api/videos/${video.id}/access`, { email: `not-registered-${stamp}@test.dev` });
await expectStatus(r, 404, "sharing with an email that has no account is refused");
assert.equal(r.json.code, "no_account");
r = await anon.call("GET", `/api/videos/${video.id}`);
assert.equal(r.json.owner.email, "", "link viewers don't get the owner's email");
assert.ok(r.json.owner.name);
ok("owner's email hidden from link viewers");
{
  const fresh = (await desktop.call("POST", "/api/videos", { title: "No thumb", mimeType: "video/mp4" })).json;
  r = await desktop.call("POST", `/api/videos/${fresh.id}/thumbnail`);
  await expectStatus(r, 409, "can't mark a thumbnail that wasn't uploaded");
  await desktop.call("DELETE", `/api/videos/${fresh.id}`);
}

section("library & lifecycle");
r = await owner.call("GET", "/api/videos?scope=mine");
assert.equal(r.json.videos.length, 1);
ok("owner library lists 1 video");
r = await owner.call("GET", "/api/videos?scope=mine&q=smoke");
assert.equal(r.json.videos.length, 1);
r = await owner.call("GET", "/api/videos?scope=mine&q=zzz");
assert.equal(r.json.videos.length, 0);
ok("search filters");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { title: "Renamed ✓" });
await expectStatus(r, 200, "rename");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { title: "   " });
await expectStatus(r, 400, "empty title rejected");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { archived: true });
r = await owner.call("GET", "/api/videos?scope=mine");
assert.equal(r.json.videos.length, 0);
r = await owner.call("GET", "/api/videos?scope=archive");
assert.equal(r.json.videos.length, 1);
ok("archive moves it");
r = await owner.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 200, "archived video still playable by link");
r = await owner.call("PATCH", `/api/videos/${video.id}`, { archived: false });
r = await owner.call("GET", "/library");
await expectStatus(r, 200, "library page renders");
assert.ok(r.text.includes("Renamed ✓"));
r = await owner.call("GET", "/settings/workspace");
await expectStatus(r, 200, "workspace settings page renders");
r = await owner.call("GET", "/download");
await expectStatus(r, 200, "download page renders");

section("profile & password");
r = await owner.call("PATCH", "/api/profile", { name: "Olivia O." });
await expectStatus(r, 200, "rename profile");
const form = new FormData();
form.set("file", new File([Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3])], "a.jpg", { type: "image/jpeg" }));
r = await owner.call("POST", "/api/profile/avatar", form);
await expectStatus(r, 200, "avatar upload");
assert.equal((await fetch(r.json.avatarUrl)).status, 200, "avatar is served from a signed URL");
assert.ok([400, 401, 403, 404].includes((await fetch(r.json.avatarUrl.split("?")[0])).status), "avatar isn't public");
// a device token (it lives in a file on the Mac) only works for recording, never for account changes
r = await desktop.call("PATCH", `/api/videos/${video.id}`, { title: "from a stolen token" });
await expectStatus(r, 403, "device token can't edit videos");
r = await desktop.call("POST", "/api/auth/password", { current: "password1", next: "hijacked1" });
await expectStatus(r, 403, "device token can't change the password");
r = await desktop.call("GET", "/api/devices");
await expectStatus(r, 403, "device token can't list or revoke devices");
r = await desktop.call("GET", "/api/workspace/members");
await expectStatus(r, 403, "device token can't manage members");
{
  const me = (await owner.call("GET", "/api/me")).json.user.id;
  r = await owner.call("POST", `/api/workspace/members/${me}/reset`);
  await expectStatus(r, 400, "no reset link for yourself (stolen sessions can't take the account over)");
}
r = await owner.call("POST", "/api/auth/password", { current: "nope", next: "password2" });
await expectStatus(r, 400, "wrong current password");
r = await owner.call("POST", "/api/auth/password", { current: "password1", next: "password2" });
await expectStatus(r, 200, "password changed");
r = await owner.call("GET", "/api/me");
await expectStatus(r, 200, "still signed in after change");
r = await desktop.call("GET", "/api/me");
await expectStatus(r, 401, "changing the password disconnects the desktop apps");
const ownerId = (await owner.call("GET", "/api/workspace/members")).json.members.find((m) => m.role === "owner").id;
r = await member.call("POST", `/api/workspace/members/${ownerId}/reset`);
await expectStatus(r, 403, "member can't reset the owner's password");
r = await owner.call("PATCH", `/api/workspace/members/${memberId}`, { role: "admin" });
r = await member.call("POST", `/api/workspace/members/${ownerId}/reset`);
await expectStatus(r, 403, "admin can't reset the owner's password");
r = await owner.call("PATCH", `/api/workspace/members/${memberId}`, { role: "member" });
r = await anon.call("GET", "/login?next=//evil.example/x");
assert.ok(!r.text.includes("//evil.example"), "protocol-relative next is dropped");
ok("open redirect blocked");
r = await owner.call("POST", `/api/workspace/members/${ivyId}/reset`);
await expectStatus(r, 200, "admin creates reset link");
const resetToken = r.json.url.split("/reset/")[1];
r = await anon.call("POST", "/api/auth/reset", { token: resetToken, password: "newpassword9" });
await expectStatus(r, 200, "reset consumed");
r = await anon.call("POST", "/api/auth/reset", { token: resetToken, password: "newpassword9" });
await expectStatus(r, 404, "reset link single-use");
r = await client().call("POST", "/api/auth/login", { email: `ivy${stamp}@test.dev`, password: "newpassword9" });
await expectStatus(r, 200, "login with new password");
{
  const ivy = client();
  await ivy.call("POST", "/api/auth/login", { email: `ivy${stamp}@test.dev`, password: "newpassword9" });
  const dev = await ivy.call("POST", "/api/desktop/connect", { deviceName: "Ivy Mac" });
  const ivyDesktop = client();
  ivyDesktop.setBearer(dev.json.token);
  await expectStatus(await ivyDesktop.call("GET", "/api/me"), 200, "ivy's desktop connected");
  const link = (await owner.call("POST", `/api/workspace/members/${ivyId}/reset`)).json.url.split("/reset/")[1];
  await anon.call("POST", "/api/auth/reset", { token: link, password: "newpassword10" });
  await expectStatus(await ivyDesktop.call("GET", "/api/me"), 401, "password reset revokes desktop tokens");
}

section("cleanup & teardown");
r = await owner.call("DELETE", `/api/videos/${video.id}`);
await expectStatus(r, 200, "delete video");
r = await owner.call("GET", `/api/videos/${video.id}`);
await expectStatus(r, 404, "deleted video is gone");
// a removed member's videos must survive and pass to the admin
{
  const ivy = client();
  await ivy.call("POST", "/api/auth/login", { email: `ivy${stamp}@test.dev`, password: "newpassword10" });
  const dev = await ivy.call("POST", "/api/desktop/connect", { deviceName: "Ivy Mac 2" });
  const ivyDesktop = client();
  ivyDesktop.setBearer(dev.json.token);
  const created = await ivyDesktop.call("POST", "/api/videos", { title: "Ivy's video", mimeType: "video/mp4" });
  r = await owner.call("DELETE", `/api/workspace/members/${ivyId}`);
  await expectStatus(r, 200, "remove member");
  r = await owner.call("GET", `/api/videos/${created.json.id}`);
  await expectStatus(r, 200, "removed member's video still exists");
  assert.equal(r.json.access, "owner");
  assert.equal(r.json.owner.email, `owner${stamp}@test.dev`);
  ok("video ownership passed to the admin");
  await owner.call("DELETE", `/api/videos/${created.json.id}`);
}
{
  const fresh = client();
  fresh.setBearer((await owner.call("POST", "/api/desktop/connect", { deviceName: "Second Mac" })).json.token);
  await expectStatus(await fresh.call("GET", "/api/me"), 200, "new device connected");
  r = await owner.call("GET", "/api/devices");
  r = await owner.call("DELETE", `/api/devices/${r.json.devices.find((d) => d.name === "Second Mac").id}`);
  r = await fresh.call("GET", "/api/me");
  await expectStatus(r, 401, "revoked device token stops working");
}
r = await owner.call("POST", "/api/auth/logout");
r = await owner.call("GET", "/api/me");
await expectStatus(r, 401, "logout");

console.log(`\n${passed} checks passed`);
