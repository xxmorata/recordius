// Makes a recorded MP4 seekable with its real length from the first byte.
//
// Chromium's MediaRecorder writes *fragmented* MP4 (moov, then moof+mdat every few seconds) and leaves the
// duration at 0 with no index: Safari and Firefox then show a short, growing length ("0:08" for a 7-minute
// video) and can't jump to a time they haven't downloaded yet. Once the recording has stopped we know
// everything, so we
//   - add a Movie Extends Header (mehd) with the total duration: the field meant for fragmented files, and
//     set the moov's own track durations to 0 (they describe only samples inside moov, which has none).
//     Chromium writes the first chunk's length there; Firefox shows that ("0:00") and can't seek. Writing the
//     total there instead makes Safari add the fragments on top (twice the length). Tested in all three.
//   - append a Movie Fragment Random Access box (mfra + mfro): an index of every fragment's start time and
//     byte offset, which players read from the end of the file to seek directly.
// The header grows by 20 bytes; fragments address their data relative to themselves (default-base-is-moof),
// so moving them is safe. The rest of the file is unchanged.

const fs = require("node:fs");

function readBox(buf, off) {
  if (off + 8 > buf.length) return null;
  let size = buf.readUInt32BE(off);
  const type = buf.toString("latin1", off + 4, off + 8);
  let header = 8;
  if (size === 1) {
    if (off + 16 > buf.length) return null;
    size = Number(buf.readBigUInt64BE(off + 8));
    header = 16;
  } else if (size === 0) size = buf.length - off;
  if (size < header) return null;
  return { off, size, type, header, end: off + size };
}

function* children(buf, start, end) {
  for (let off = start; off < end; ) {
    const b = readBox(buf, off);
    if (!b || b.end > end) return;
    yield b;
    off = b.end;
  }
}

const find = (buf, parent, type) => {
  for (const b of children(buf, parent.off + parent.header, parent.end)) if (b.type === type) return b;
  return null;
};

/** Reads the top-level boxes of a file without loading the media data. */
function topLevel(fd, fileSize) {
  const boxes = [];
  const head = Buffer.alloc(16);
  for (let off = 0; off + 8 <= fileSize; ) {
    fs.readSync(fd, head, 0, 16, off);
    let size = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    if (size === 1) size = Number(head.readBigUInt64BE(8));
    else if (size === 0) size = fileSize - off;
    if (size < 8 || off + size > fileSize) break; // a truncated last box (crash mid-write)
    boxes.push({ off, size, type });
    off += size;
  }
  return boxes;
}

const readAt = (fd, off, size) => {
  const b = Buffer.alloc(size);
  fs.readSync(fd, b, 0, size, off);
  return b;
};

/** Track ids, timescales and trex defaults from the moov box. */
function parseMoov(moov) {
  const root = { off: 0, size: moov.length, header: 8, end: moov.length };
  const mvhd = find(moov, root, "mvhd");
  const movieTimescale = moov[mvhd.off + 8] === 1 ? moov.readUInt32BE(mvhd.off + 28) : moov.readUInt32BE(mvhd.off + 20);
  const tracks = new Map();
  for (const trak of children(moov, 8, moov.length)) {
    if (trak.type !== "trak") continue;
    const tkhd = find(moov, trak, "tkhd");
    const id = moov[tkhd.off + 8] === 1 ? moov.readUInt32BE(tkhd.off + 28) : moov.readUInt32BE(tkhd.off + 20);
    const mdhd = find(moov, find(moov, trak, "mdia"), "mdhd");
    const timescale = moov[mdhd.off + 8] === 1 ? moov.readUInt32BE(mdhd.off + 28) : moov.readUInt32BE(mdhd.off + 20);
    tracks.set(id, { id, tkhd, mdhd, timescale, defaultDuration: 0, end: 0, fragments: [] });
  }
  const mvex = find(moov, root, "mvex");
  if (mvex)
    for (const trex of children(moov, mvex.off + 8, mvex.end))
      if (trex.type === "trex") {
        const t = tracks.get(moov.readUInt32BE(trex.off + 12));
        if (t) t.defaultDuration = moov.readUInt32BE(trex.off + 20);
      }
  return { mvhd, movieTimescale, tracks, mvex };
}

/** Start time and total duration of each track fragment in a moof. */
function parseMoof(moof, moofOffset, tracks) {
  for (const traf of children(moof, 8, moof.length)) {
    if (traf.type !== "traf") continue;
    let track = null;
    let defaultDuration = 0;
    let start = null;
    let total = 0;
    for (const b of children(moof, traf.off + 8, traf.end)) {
      if (b.type === "tfhd") {
        const flags = moof.readUInt32BE(b.off + 8) & 0xffffff;
        track = tracks.get(moof.readUInt32BE(b.off + 12));
        let p = b.off + 16;
        if (flags & 0x1) p += 8; // base data offset
        if (flags & 0x2) p += 4; // sample description index
        defaultDuration = flags & 0x8 ? moof.readUInt32BE(p) : (track?.defaultDuration ?? 0);
      } else if (b.type === "tfdt") {
        start = moof[b.off + 8] === 1 ? Number(moof.readBigUInt64BE(b.off + 12)) : moof.readUInt32BE(b.off + 12);
      } else if (b.type === "trun") {
        const flags = moof.readUInt32BE(b.off + 8) & 0xffffff;
        const count = moof.readUInt32BE(b.off + 12);
        let p = b.off + 16;
        if (flags & 0x1) p += 4; // data offset
        if (flags & 0x4) p += 4; // first sample flags
        const per = [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length * 4;
        if (flags & 0x100) for (let i = 0; i < count; i++) total += moof.readUInt32BE(p + i * per);
        else total += count * defaultDuration;
      }
    }
    if (!track || start === null) continue;
    track.fragments.push({ time: start, moofOffset });
    track.end = Math.max(track.end, start + total);
  }
}

/** True if the file already ends with an mfra index (finalized before, e.g. retried upload). */
function isIndexed(file) {
  const size = fs.statSync(file).size;
  if (size < 16) return false;
  const fd = fs.openSync(file, "r");
  try {
    const tail = readAt(fd, size - 16, 16);
    if (tail.toString("latin1", 4, 8) !== "mfro") return false;
    const mfraSize = tail.readUInt32BE(12);
    return mfraSize <= size && readAt(fd, size - mfraSize, 8).toString("latin1", 4, 8) === "mfra";
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Computes the header patch and the index for a fragmented MP4 on disk.
 * Returns null when the file isn't fragmented MP4 (WebM, or a regular MP4) or is already indexed.
 * { header: Buffer (replaces bytes 0..header.length), tail: Buffer (append), durationMs }
 */
function plan(file) {
  if (isIndexed(file)) return null;
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    const boxes = topLevel(fd, size);
    while (boxes.length && boxes[boxes.length - 1].type === "moof") boxes.pop(); // its media data was cut off
    const moovBox = boxes.find((b) => b.type === "moov");
    if (!moovBox || !boxes.some((b) => b.type === "moof")) return null;
    const moov = readAt(fd, moovBox.off, moovBox.size);
    const { movieTimescale, tracks, mvex } = parseMoov(moov);
    if (!mvex || !tracks.size) return null;
    for (const b of boxes) if (b.type === "moof") parseMoof(readAt(fd, b.off, b.size), b.off, tracks);
    // A box cut short by a crash isn't part of the file anymore: the index only covers whole fragments.
    const lastWhole = boxes[boxes.length - 1];
    const usable = lastWhole.off + lastWhole.size;

    const seconds = Math.max(...[...tracks.values()].map((t) => t.end / t.timescale));
    if (!Number.isFinite(seconds) || seconds <= 0) return null;

    // mehd (version 1: 64-bit fragment_duration in the movie timescale) at the start of mvex.
    if (find(moov, mvex, "mehd")) return null; // already has a total duration
    const mehd = Buffer.alloc(20);
    mehd.writeUInt32BE(20, 0);
    mehd.write("mehd", 4, "latin1");
    mehd.writeUInt32BE(0x01000000, 8);
    mehd.writeBigUInt64BE(BigInt(Math.round(seconds * movieTimescale)), 12);
    const zero = (box, v1Offset, v0Offset) => {
      if (moov[box.off + 8] === 1) moov.writeBigUInt64BE(0n, box.off + v1Offset);
      else moov.writeUInt32BE(0, box.off + v0Offset);
    };
    for (const t of tracks.values()) {
      zero(t.tkhd, 36, 28);
      zero(t.mdhd, 32, 24);
    }
    const at = mvex.off + mvex.header;
    const newMoov = Buffer.concat([moov.subarray(0, at), mehd, moov.subarray(at)]);
    newMoov.writeUInt32BE(moov.length + 20, 0);
    newMoov.writeUInt32BE(mvex.size + 20, mvex.off);
    const header = Buffer.concat([readAt(fd, 0, moovBox.off), newMoov]);
    const shift = header.length - (moovBox.off + moovBox.size);
    for (const t of tracks.values()) for (const f of t.fragments) f.moofOffset += shift;

    // mfra = tfra per track (version 1: 64-bit time and offset; traf/trun/sample numbers 1 byte each) + mfro.
    const tfras = [...tracks.values()]
      .filter((t) => t.fragments.length)
      .map((t) => {
        const b = Buffer.alloc(24 + t.fragments.length * 19);
        b.writeUInt32BE(b.length, 0);
        b.write("tfra", 4, "latin1");
        b.writeUInt32BE(0x01000000, 8); // version 1, flags 0
        b.writeUInt32BE(t.id, 12);
        b.writeUInt32BE(0, 16); // length_size_of_traf/trun/sample_num = 0 → 1 byte each
        b.writeUInt32BE(t.fragments.length, 20);
        t.fragments.forEach((f, i) => {
          const p = 24 + i * 19;
          b.writeBigUInt64BE(BigInt(f.time), p);
          b.writeBigUInt64BE(BigInt(f.moofOffset), p + 8);
          b[p + 16] = 1;
          b[p + 17] = 1;
          b[p + 18] = 1;
        });
        return b;
      });
    const mfro = Buffer.alloc(16);
    const mfraSize = 8 + tfras.reduce((n, b) => n + b.length, 0) + 16;
    mfro.writeUInt32BE(16, 0);
    mfro.write("mfro", 4, "latin1");
    mfro.writeUInt32BE(mfraSize, 12);
    const mfraHead = Buffer.alloc(8);
    mfraHead.writeUInt32BE(mfraSize, 0);
    mfraHead.write("mfra", 4, "latin1");
    // The new file = header + original bytes [headerEnd, usableSize) + tail.
    return { header, headerEnd: moovBox.off + moovBox.size, tail: Buffer.concat([mfraHead, ...tfras, mfro]), durationMs: Math.round(seconds * 1000), usableSize: usable };
  } finally {
    fs.closeSync(fd);
  }
}

/** Applies plan() to the file itself (rewritten through a temp file, then renamed). Returns the plan, or null. */
function finalizeFile(file) {
  const p = plan(file);
  return p ? applyPlan(file, p) : null;
}

function applyPlan(file, p) {
  const tmp = `${file}.indexing`;
  const src = fs.openSync(file, "r");
  const out = fs.openSync(tmp, "w");
  try {
    fs.writeSync(out, p.header);
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    for (let pos = p.headerEnd; pos < p.usableSize; ) {
      const n = fs.readSync(src, chunk, 0, Math.min(chunk.length, p.usableSize - pos), pos);
      if (!n) break;
      fs.writeSync(out, chunk, 0, n);
      pos += n;
    }
    fs.writeSync(out, p.tail);
    fs.fsyncSync(out);
  } catch (err) {
    fs.closeSync(out);
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    fs.closeSync(src);
  }
  fs.closeSync(out);
  fs.renameSync(tmp, file);
  return p;
}

module.exports = { plan, applyPlan, finalizeFile, isIndexed };
