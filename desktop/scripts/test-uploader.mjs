#!/usr/bin/env node
// Unit test for the live uploader (src/uploader.js) with a fake storage target: network outages while
// recording, the in-memory cap (parts read back from the local file), and the whole-file fallback.
//   node scripts/test-uploader.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LiveUploader } = require("../src/uploader.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordius-uploader-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
let passed = 0;
const ok = (name) => (passed++, console.log(`  ✓ ${name}`));

/** A storage target that keeps parts in memory and can be made to fail. */
function fakeTarget({ partSize = 64 * 1024, failUntil = 0, failAlways = false, slowMs = 0 } = {}) {
  const t = {
    partSize,
    parts: new Map(),
    whole: null,
    calls: 0,
    maxInMemory: 0,
    async create() {
      return { uploadId: "u1" };
    },
    async uploadPart(_mpu, n, body) {
      t.calls++;
      if (failAlways || Date.now() < failUntil) throw new Error("network down");
      if (slowMs) await wait(slowMs);
      t.parts.set(n, Buffer.from(body));
      return { partNumber: n, etag: `"${n}"` };
    },
    async complete(_mpu, parts) {
      t.completed = parts.map((p) => p.partNumber);
    },
    async putFile(localPath) {
      t.whole = fs.readFileSync(localPath);
    },
  };
  return t;
}

/** Feeds `seconds` of fake recording (one chunk per tick) into an uploader. */
async function record(uploader, { chunks, chunkSize, tickMs = 5 }) {
  const all = [];
  for (let i = 0; i < chunks; i++) {
    const c = Buffer.alloc(chunkSize, i % 251);
    c.writeUInt32BE(i, 0);
    all.push(c);
    uploader.push(c);
    await wait(tickMs);
  }
  return Buffer.concat(all);
}

const assembled = (t) => Buffer.concat([...t.parts.keys()].sort((a, b) => a - b).map((n) => t.parts.get(n)));

try {
  // 1. Normal: parts upload live, in order, byte for byte.
  {
    const t = fakeTarget();
    const u = new LiveUploader({ target: t, contentType: "video/mp4", localPath: path.join(dir, "a.mp4") });
    const data = await record(u, { chunks: 40, chunkSize: 10_000 });
    await u.finish();
    assert.deepEqual(t.completed, [...t.parts.keys()].sort((a, b) => a - b));
    assert.equal(sha(assembled(t)), sha(data));
    assert.equal(sha(fs.readFileSync(path.join(dir, "a.mp4"))), sha(data), "local copy is complete");
    ok("parts upload live and assemble to the exact recording");
  }

  // 2. The network is down for a while during the recording: retried, nothing lost, still a live upload.
  {
    const t = fakeTarget({ failUntil: Date.now() + 2500 });
    const u = new LiveUploader({ target: t, contentType: "video/mp4", localPath: path.join(dir, "b.mp4") });
    const data = await record(u, { chunks: 80, chunkSize: 10_000, tickMs: 50 });
    await u.finish();
    assert.equal(t.whole, null, "no whole-file fallback needed");
    assert.ok(t.completed?.length > 5);
    assert.equal(sha(assembled(t)), sha(data));
    ok("a 2.5 s outage mid-recording is retried; the live upload completes");
  }

  // 3. Slow uplink: only a bounded amount stays in memory; the rest is read back from the file.
  {
    const partSize = 1024 * 1024;
    const t = fakeTarget({ partSize, slowMs: 150 });
    const u = new LiveUploader({ target: t, contentType: "video/mp4", localPath: path.join(dir, "c.mp4") });
    let peak = 0;
    const timer = setInterval(() => (peak = Math.max(peak, u.queuedBytes)), 5);
    const data = await record(u, { chunks: 120, chunkSize: partSize, tickMs: 1 }); // 120 MB "recorded" far faster than uploaded
    await u.finish();
    clearInterval(timer);
    assert.ok(peak <= 64 * 1024 * 1024 + partSize, `queued bytes stayed bounded (peak ${Math.round(peak / 1024 / 1024)} MB)`);
    assert.equal(sha(assembled(t)), sha(data), "parts read back from the file are correct");
    ok(`slow uplink: memory capped at ${Math.round(peak / 1024 / 1024)} MB, parts re-read from disk correctly`);
  }

  // 4. The network never comes back: after stopping, the whole local file is uploaded instead.
  {
    const t = fakeTarget({ failAlways: true });
    t.putFile = async (p) => (t.whole = fs.readFileSync(p)); // the fallback path works (another network)
    const u = new LiveUploader({ target: t, contentType: "video/mp4", localPath: path.join(dir, "d.mp4") });
    const data = await record(u, { chunks: 20, chunkSize: 10_000 });
    const started = Date.now();
    await u.finish();
    assert.equal(sha(t.whole), sha(data));
    assert.ok(Date.now() - started < 60_000, "gives up on live parts in reasonable time after stop");
    ok("permanent outage: falls back to uploading the local file");
  }

  // 5. The local copy can't be written (disk full): no crash, the live upload carries on.
  {
    const t = fakeTarget();
    const u = new LiveUploader({ target: t, contentType: "video/mp4", localPath: path.join(dir, "missing-dir", "e.mp4") });
    const data = await record(u, { chunks: 30, chunkSize: 10_000 });
    await u.finish();
    assert.ok(u.fileError, "the write error was caught");
    assert.equal(sha(assembled(t)), sha(data));
    ok("local write errors don't crash the app; the live upload still completes");
  }

  console.log(`\n${passed} checks passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
