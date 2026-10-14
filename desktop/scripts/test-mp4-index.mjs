#!/usr/bin/env node
// Unit test for src/mp4-index.js (duration + seek index for recorded MP4s) and its use by the live uploader.
// Builds a small fragmented MP4 shaped like Chromium's MediaRecorder output.
//   node scripts/test-mp4-index.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mp4 = require("../src/mp4-index.js");
const { LiveUploader } = require("../src/uploader.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordius-mp4-"));
let passed = 0;
const ok = (name) => (passed++, console.log(`  ✓ ${name}`));
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ───────── a fragmented MP4 like MediaRecorder writes ─────────

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]);
};
const full = (type, version, flags, ...parts) => box(type, u32((version << 24) | flags), ...parts);

const TRACKS = [
  { id: 1, timescale: 30000, sampleDuration: 1000 }, // video, 30 fps
  { id: 2, timescale: 48000, sampleDuration: 960 }, // audio, 20 ms frames
];
const SAMPLES_PER_FRAGMENT = 90; // 3 s of video per fragment
function buildRecording(fragments) {
  const ftyp = box("ftyp", Buffer.from("isom"), u32(0x200), Buffer.from("isomiso2avc1mp41"));
  const traks = TRACKS.map((t) =>
    box(
      "trak",
      full("tkhd", 1, 3, u64(0), u64(0), u32(t.id), u32(0), u64(0), Buffer.alloc(60)),
      box("mdia", full("mdhd", 1, 0, u64(0), u64(0), u32(t.timescale), u64(t.sampleDuration * 9), u32(0)), box("hdlr", Buffer.alloc(25))),
    ),
  );
  const trexes = TRACKS.map((t) => full("trex", 0, 0, u32(t.id), u32(1), u32(0), u32(0), u32(0)));
  const moov = box("moov", full("mvhd", 1, 0, u64(0), u64(0), u32(1000), u64(0), Buffer.alloc(80)), ...traks, box("mvex", ...trexes));
  const out = [ftyp, moov];
  for (let f = 0; f < fragments; f++) {
    const trafs = TRACKS.map((t) => {
      const count = t.id === 1 ? SAMPLES_PER_FRAGMENT : (SAMPLES_PER_FRAGMENT / 30) * (48000 / 960);
      const durations = Buffer.concat(Array.from({ length: count }, () => Buffer.concat([u32(t.sampleDuration), u32(100)])));
      const start = t.id === 1 ? f * SAMPLES_PER_FRAGMENT * t.sampleDuration : f * count * t.sampleDuration;
      // tfhd: default-base-is-moof; trun: data offset + per-sample duration and size
      return box("traf", full("tfhd", 0, 0x20000, u32(t.id)), full("tfdt", 1, 0, u64(start)), full("trun", 0, 0x301, u32(count), u32(0), durations));
    });
    out.push(box("moof", full("mfhd", 0, 0, u32(f + 1)), ...trafs), box("mdat", Buffer.alloc(20_000 + f, f)));
  }
  return Buffer.concat(out);
}

function topBoxes(buf) {
  const boxes = [];
  for (let off = 0; off < buf.length; ) {
    const size = buf.readUInt32BE(off);
    boxes.push({ off, size, type: buf.toString("latin1", off + 4, off + 8) });
    off += size;
  }
  return boxes;
}

try {
  // 1. Duration in mehd, track durations zeroed, and an mfra that points at every fragment.
  {
    const file = path.join(dir, "a.mp4");
    const original = buildRecording(10); // 10 × 3 s
    fs.writeFileSync(file, original);
    const plan = mp4.finalizeFile(file);
    assert.equal(plan.durationMs, 30000);
    const out = fs.readFileSync(file);
    assert.equal(out.length, original.length + 20 + plan.tail.length);
    const boxes = topBoxes(out);
    assert.deepEqual([...new Set(boxes.map((b) => b.type))], ["ftyp", "moov", "moof", "mdat", "mfra"]);
    const moov = out.subarray(boxes[1].off, boxes[1].off + boxes[1].size);
    const mehdAt = moov.indexOf("mehd");
    assert.ok(mehdAt > 0, "mehd added");
    assert.equal(Number(moov.readBigUInt64BE(mehdAt + 8)), 30000, "mehd = 30 s in the movie timescale");
    const mdhdAt = moov.indexOf("mdhd");
    assert.equal(Number(moov.readBigUInt64BE(mdhdAt + 4 + 24)), 0, "track duration zeroed (Firefox reads it)");
    // every tfra entry points at a moof, in order
    const moofs = boxes.filter((b) => b.type === "moof").map((b) => b.off);
    const mfra = boxes.find((b) => b.type === "mfra");
    const tfra = mfra.off + 8;
    const entries = out.readUInt32BE(tfra + 20);
    assert.equal(entries, 10);
    for (let i = 0; i < entries; i++) {
      const p = tfra + 24 + i * 19;
      assert.equal(Number(out.readBigUInt64BE(p)), i * 90000, "fragment start time");
      assert.equal(Number(out.readBigUInt64BE(p + 8)), moofs[i], "fragment offset");
    }
    assert.equal(out.readUInt32BE(out.length - 4), mfra.size, "mfro points back at mfra");
    // the media itself is untouched
    assert.equal(sha(out.subarray(boxes[2].off, mfra.off)), sha(original.subarray(boxes[2].off - 20, original.length)));
    assert.ok(mp4.isIndexed(file));
    assert.equal(mp4.plan(file), null, "running it twice changes nothing");
    ok("adds the duration and a seek index; the media data is untouched; idempotent");
  }

  // 2. A recording cut short by a crash: the half-written fragment is dropped, the rest indexed.
  {
    const file = path.join(dir, "b.mp4");
    const whole = buildRecording(6);
    const cut = whole.subarray(0, whole.length - 5000); // the last mdat is incomplete
    fs.writeFileSync(file, cut);
    const plan = mp4.finalizeFile(file);
    assert.equal(plan.durationMs, 15000, "5 whole fragments");
    const boxes = topBoxes(fs.readFileSync(file));
    assert.equal(boxes.filter((b) => b.type === "moof").length, 5);
    assert.equal(boxes.at(-1).type, "mfra");
    ok("a crash-truncated recording keeps its whole fragments and gets an index");
  }

  // 3. Not a fragmented MP4 (WebM, or garbage): left alone.
  {
    const file = path.join(dir, "c.webm");
    fs.writeFileSync(file, Buffer.from("1a45dfa3" + "00".repeat(200), "hex"));
    assert.equal(mp4.finalizeFile(file), null);
    ok("other files are left alone");
  }

  // 4. The live uploader: header part held back, uploaded bytes == indexed local file.
  for (const [label, fragments, partSize] of [
    ["several parts", 40, 64 * 1024],
    ["shorter than one part", 3, 8 * 1024 * 1024],
  ]) {
    const parts = new Map();
    let firstUploadedAt = null;
    let pushedAll = false;
    const target = {
      partSize,
      async create() {
        return { uploadId: "u" };
      },
      async uploadPart(_m, n, body) {
        if (n === 1) firstUploadedAt = pushedAll ? "after stop" : "while recording";
        parts.set(n, Buffer.from(body));
        return { partNumber: n, etag: `"${n}"` };
      },
      async complete() {},
      async putFile() {
        throw new Error("no fallback expected");
      },
    };
    const localPath = path.join(dir, `live-${fragments}.mp4`);
    const u = new LiveUploader({ target, contentType: "video/mp4", localPath });
    const rec = buildRecording(fragments);
    for (let i = 0; i < rec.length; i += 7000) {
      u.push(rec.subarray(i, i + 7000));
      await new Promise((r) => setTimeout(r, 1));
    }
    pushedAll = true;
    await u.finish();
    const uploaded = Buffer.concat([...parts.keys()].sort((a, b) => a - b).map((n) => parts.get(n)));
    const local = fs.readFileSync(localPath);
    assert.equal(sha(uploaded), sha(local), "upload = local copy");
    assert.ok(mp4.isIndexed(localPath), "indexed");
    assert.equal(u.totalBytes, local.length, "reported size is the final size");
    assert.equal(firstUploadedAt, "after stop", "the header part goes last");
    if (fragments > 3) assert.ok(parts.size > 3, "the rest uploaded as separate parts");
    ok(`live upload (${label}): the uploaded file is the indexed recording`);
  }

  console.log(`\n${passed} checks passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
