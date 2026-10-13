#!/usr/bin/env node
// Unit test for src/library.js (failed-upload queue + local-copy cleanup). Runs without Electron:
//   node scripts/test-library.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "recordius-library-"));
const userData = path.join(root, "data");
const home = path.join(root, "home");

// src/config.js asks Electron for the data folder and reads the home folder for ~/Movies/Recordius.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { app: { getPath: () => userData } };
  return load.call(this, request, ...rest);
};
os.homedir = () => home;

const lib = require("../src/library.js");
const config = require("../src/config.js");
fs.mkdirSync(config.RECORDINGS_DIR, { recursive: true });

const id = (c) => c.repeat(32);
const DAY = 864e5;
function recording(name, ageDays) {
  const file = path.join(config.RECORDINGS_DIR, name);
  fs.writeFileSync(file, "video");
  const t = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(file, t, t);
  return file;
}
let passed = 0;
const ok = (name) => (passed++, console.log(`  ✓ ${name}`));

try {
  const oldUploaded = recording(`2026-09-01 10.00.00 ${id("a")}.mp4`, 40);
  const recentUploaded = recording(`2026-10-10 10.00.00 ${id("b")}.mp4`, 3);
  const oldPending = recording(`2026-09-01 10.00.00 ${id("c")}.mp4`, 40);
  const oldUnknown = recording(`2026-09-01 10.00.00 ${id("d")}.mp4`, 40); // e.g. from before the ledger existed
  const renamedByUser = recording(`my notes ${id("e")}.mp4`, 40);
  const active = recording(`2026-09-01 10.00.00 ${id("f")}.webm`, 40);
  for (const [c, f] of [["a", oldUploaded], ["b", recentUploaded], ["c", oldPending], ["e", renamedByUser], ["f", active]]) lib.markUploaded(id(c), f);
  lib.addPending({ id: id("c"), server: "https://s", localPath: oldPending, durationMs: 1, shareUrl: "u", failedAt: 1 });

  assert.equal(lib.cleanUpLocalCopies({ keepDays: 0 }), 0);
  assert.ok(fs.existsSync(oldUploaded));
  ok("“forever” keeps everything");

  assert.equal(lib.cleanUpLocalCopies({ keepDays: 30, activePath: active }), 1);
  assert.ok(!fs.existsSync(oldUploaded), "old uploaded copy removed");
  for (const f of [recentUploaded, oldPending, oldUnknown, renamedByUser, active]) assert.ok(fs.existsSync(f), `kept ${path.basename(f)}`);
  ok("30 days: only old, uploaded, idle recordings are removed");

  assert.equal(lib.cleanUpLocalCopies({ keepDays: 7 }), 1);
  assert.ok(!fs.existsSync(active));
  assert.ok(fs.existsSync(oldPending) && fs.existsSync(oldUnknown) && fs.existsSync(renamedByUser));
  ok("pending, unknown and renamed files are never removed");

  const ledger = JSON.parse(fs.readFileSync(path.join(userData, "uploaded.json"), "utf8"));
  assert.deepEqual(Object.keys(ledger).map((k) => k[0]).sort(), ["b", "c", "e"]);
  ok("ledger forgets files that are gone");

  lib.addPending({ id: id("c"), server: "https://s", localPath: oldPending, durationMs: 2, shareUrl: "u", failedAt: 2 });
  assert.equal(lib.pending().length, 1, "re-adding replaces");
  lib.updatePending(id("c"), { error: "offline" });
  assert.equal(lib.pending()[0].error, "offline");
  assert.equal(lib.pending()[0].durationMs, 2);
  lib.removePending(id("c"));
  assert.equal(lib.pending().length, 0);
  ok("pending queue add / update / remove");

  fs.writeFileSync(path.join(userData, "pending-uploads.json"), "{not json");
  assert.deepEqual(lib.pending(), []);
  fs.writeFileSync(path.join(userData, "pending-uploads.json"), JSON.stringify([{ id: 1 }, null, { id: id("z"), localPath: "/x" }]));
  assert.deepEqual(lib.pending().map((p) => p.id), [id("z")]);
  ok("a damaged queue file never crashes the app");

  console.log(`\n${passed} checks passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
