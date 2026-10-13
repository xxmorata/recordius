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

section("recording flow (real private-blob upload)");
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
const { videoPathname: p, videoToken: token, thumbPathname, thumbToken } = video.upload;
const mpu = await createMultipartUpload(p, { access: "private", token, contentType: "video/mp4" });
const partA = Buffer.alloc(5 * 1024 * 1024, 1);
const partB = Buffer.from("tail");
const parts = [
  await uploadPart(p, partA, { access: "private", token, uploadId: mpu.uploadId, key: mpu.key, partNumber: 1 }),
  await uploadPart(p, partB, { access: "private", token, uploadId: mpu.uploadId, key: mpu.key, partNumber: 2 }),
];
await completeMultipartUpload(p, parts, { access: "private", token, uploadId: mpu.uploadId, key: mpu.key, contentType: "video/mp4" });
ok("multipart upload with scoped token");
await put(thumbPathname, Buffer.from("fakejpeg"), { access: "private", token: thumbToken, contentType: "image/jpeg" });
r = await desktop.call("POST", `/api/videos/${video.id}/thumbnail`);
await expectStatus(r, 200, "thumbnail marked");
await assert.rejects(() => createMultipartUpload(`videos/${video.id}/evil.mp4`, { access: "private", token }), "scoped token can't write elsewhere");
ok("scoped token can't write elsewhere");
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
const plain = await fetch(`https://${new URL(r.json.videoUrl).host}/${p}`);
assert.equal(plain.status, 403);
ok("raw blob url is private");

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
assert.ok(r.json.avatarUrl.includes("private.blob"));
r = await owner.call("POST", "/api/auth/password", { current: "nope", next: "password2" });
await expectStatus(r, 400, "wrong current password");
r = await owner.call("POST", "/api/auth/password", { current: "password1", next: "password2" });
await expectStatus(r, 200, "password changed");
r = await owner.call("GET", "/api/me");
await expectStatus(r, 200, "still signed in after change");
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
r = await owner.call("GET", "/api/devices");
const deviceId = r.json.devices[0].id;
r = await owner.call("DELETE", `/api/devices/${deviceId}`);
r = await desktop.call("GET", "/api/me");
await expectStatus(r, 401, "revoked device token stops working");
r = await owner.call("POST", "/api/auth/logout");
r = await owner.call("GET", "/api/me");
await expectStatus(r, 401, "logout");

console.log(`\n${passed} checks passed`);
