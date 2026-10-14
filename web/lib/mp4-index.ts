/*
 * Seek index for recorded MP4s, server side. The desktop app does the same for new recordings
 * (desktop/src/mp4-index.js); this repairs recordings uploaded before that, and ones from older apps.
 *
 * Chromium's MediaRecorder writes fragmented MP4 (moov, then moof+mdat every few seconds) with no total
 * duration and no index. Firefox then knows only the first chunk ("0:00") and can't jump ahead. Once the
 * file is complete we know everything, so we
 *   - add a Movie Extends Header (mehd) with the total duration and zero the moov's own track durations
 *     (they describe only samples inside moov, which has none; Chromium writes the first chunk's length there
 *     and Firefox believes it; writing the total there instead makes Safari double the length), and
 *   - append a Movie Fragment Random Access box (mfra + mfro): every fragment's start time and byte offset,
 *     which players read from the end of the file to seek directly.
 * The file is scanned as a stream (media data is skipped, never buffered), so a multi-GB recording needs
 * only a few MB of memory. The result: new header + the original bytes after the moov + the index.
 */

export type IndexPlan = {
  /** Replaces the file's first `headerEnd` bytes. */
  header: Buffer;
  headerEnd: number;
  /** Appended after byte `usableSize`. */
  tail: Buffer;
  /** End of the last complete fragment (a crash can leave a half-written box at the end). */
  usableSize: number;
  durationMs: number;
};

type Box = { off: number; size: number; type: string; header: number; end: number };
type Track = { id: number; tkhd: Box; mdhd: Box; timescale: number; defaultDuration: number; end: number; fragments: { time: number; moofOffset: number }[] };

const MAX_MOOV_BYTES = 64 * 1024 ** 2;
const MAX_MOOF_BYTES = 16 * 1024 ** 2;
const MAX_PREFIX_BYTES = 1024 ** 2; // boxes before moov (ftyp, free)

function readBox(buf: Buffer, off: number): Box | null {
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

function* children(buf: Buffer, start: number, end: number): Generator<Box> {
  for (let off = start; off < end; ) {
    const b = readBox(buf, off);
    if (!b || b.end > end) return;
    yield b;
    off = b.end;
  }
}

function find(buf: Buffer, parent: Box, type: string): Box | null {
  for (const b of children(buf, parent.off + parent.header, parent.end)) if (b.type === type) return b;
  return null;
}

const versionField = (buf: Buffer, box: Box, v1Offset: number, v0Offset: number) => (buf[box.off + 8] === 1 ? buf.readUInt32BE(box.off + v1Offset) : buf.readUInt32BE(box.off + v0Offset));

function parseMoov(moov: Buffer) {
  const root: Box = { off: 0, size: moov.length, type: "moov", header: 8, end: moov.length };
  const mvhd = find(moov, root, "mvhd");
  if (!mvhd) throw new Error("moov without mvhd");
  const movieTimescale = versionField(moov, mvhd, 28, 20);
  const tracks = new Map<number, Track>();
  for (const trak of children(moov, 8, moov.length)) {
    if (trak.type !== "trak") continue;
    const tkhd = find(moov, trak, "tkhd");
    const mdia = tkhd && find(moov, trak, "mdia");
    const mdhd = mdia && find(moov, mdia, "mdhd");
    if (!tkhd || !mdhd) continue;
    const id = versionField(moov, tkhd, 28, 20);
    tracks.set(id, { id, tkhd, mdhd, timescale: versionField(moov, mdhd, 28, 20), defaultDuration: 0, end: 0, fragments: [] });
  }
  const mvex = find(moov, root, "mvex");
  if (mvex)
    for (const trex of children(moov, mvex.off + 8, mvex.end))
      if (trex.type === "trex") {
        const t = tracks.get(moov.readUInt32BE(trex.off + 12));
        if (t) t.defaultDuration = moov.readUInt32BE(trex.off + 20);
      }
  return { movieTimescale, tracks, mvex, hasMehd: Boolean(mvex && find(moov, mvex, "mehd")) };
}

/** Start time and total duration of each track's fragment in a moof. */
function parseMoof(moof: Buffer, moofOffset: number, tracks: Map<number, Track>) {
  for (const traf of children(moof, 8, moof.length)) {
    if (traf.type !== "traf") continue;
    let track: Track | undefined;
    let defaultDuration = 0;
    let start: number | null = null;
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

export type ByteSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

/**
 * Web streams and async iterables alike. A web stream is read through its reader, not its async iterator:
 * stopping early then cancels it right away (the iterator's return() waits for the whole download first).
 */
async function* iterate(src: ByteSource): AsyncGenerator<Uint8Array> {
  if (typeof (src as ReadableStream<Uint8Array>).getReader !== "function") {
    yield* src as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (src as ReadableStream<Uint8Array>).getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    // Cancelling a body that was already fully received can hang in some runtimes: never wait long for it.
    if (!finished) await Promise.race([reader.cancel().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    else reader.releaseLock();
  }
}

/** Reads a byte stream in order: whole boxes we keep, skipped ranges we don't. */
class Cursor {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  private it: AsyncIterator<Uint8Array>;
  constructor(source: ByteSource) {
    this.it = iterate(source);
  }
  private async fill(n: number) {
    while (this.buffered < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else if (r.value.length) {
        this.chunks.push(r.value);
        this.buffered += r.value.length;
      }
    }
  }
  /** Up to n bytes without consuming them. */
  async peek(n: number): Promise<Buffer> {
    await this.fill(n);
    return Buffer.concat(this.chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length))).subarray(0, n);
  }
  async read(n: number): Promise<Buffer> {
    const b = await this.peek(n);
    if (b.length < n) throw new Error("unexpected end of file");
    this.drop(n);
    return Buffer.from(b);
  }
  async skip(n: number): Promise<boolean> {
    while (n > 0) {
      if (!this.buffered) await this.fill(1);
      if (!this.buffered) return false;
      const take = Math.min(n, this.buffered);
      this.drop(take);
      n -= take;
    }
    return true;
  }
  private drop(n: number) {
    while (n > 0 && this.chunks.length) {
      const c = this.chunks[0];
      if (c.length <= n) {
        n -= c.length;
        this.buffered -= c.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = c.subarray(n);
        this.buffered -= n;
        n = 0;
      }
    }
  }
  /**
   * `fullyRead`: every byte of the file was consumed — then the source is drained (one more read that
   * reports the end) rather than cancelled; cancelling a finished body can hang. Otherwise it's cancelled.
   */
  async close(fullyRead: boolean) {
    this.chunks = [];
    this.buffered = 0;
    if (fullyRead && !this.done) {
      const r = await Promise.race([this.it.next(), new Promise<null>((res) => setTimeout(() => res(null), 3000))]);
      if (r && r.done) this.done = true;
    }
    if (!this.done) await Promise.race([this.it.return?.().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    this.done = true;
  }
}

/**
 * Scans a file as it streams by and returns what to change, or null when there's nothing to do: not an
 * MP4, a regular (non-fragmented) MP4, or one that already has the index. Only the moov and moof boxes
 * are kept in memory; media data is skipped.
 */
export async function scanMp4(source: ByteSource, totalSize: number): Promise<IndexPlan | null> {
  const cur = new Cursor(source);
  let pos = 0;
  try {
    const prefix: Buffer[] = [];
    let prefixBytes = 0;
    let moov: Buffer | null = null;
    let moovOff = 0;
    let info: ReturnType<typeof parseMoov> | null = null;
    let usable = 0;
    let lastMoof: { off: number; end: number } | null = null;
    while (pos < totalSize) {
      const head = await cur.peek(16);
      const b = readBox(head, 0);
      if (!b || (b.size === head.length - 0 && head.readUInt32BE(0) === 0)) break; // garbage or end
      let size = head.readUInt32BE(0);
      let header = 8;
      if (size === 1) {
        size = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (size === 0) size = totalSize - pos;
      if (size < header || pos + size > totalSize) break; // a box cut short (crash while writing): stop here
      const type = b.type;
      if (type === "moov") {
        if (size > MAX_MOOV_BYTES) return null;
        moov = await cur.read(size);
        moovOff = pos;
        info = parseMoov(moov);
        if (!info.mvex) return null; // a regular MP4: has its own index
        if (info.hasMehd) return null; // already done
      } else if (type === "moof") {
        if (!info || size > MAX_MOOF_BYTES) return null;
        parseMoof(await cur.read(size), pos, info.tracks);
        lastMoof = { off: pos, end: pos + size };
      } else if (type === "mfra") {
        return null; // already indexed
      } else if (!moov) {
        // ftyp and the like. Anything big before the moov means this isn't a MediaRecorder file.
        if (size > MAX_PREFIX_BYTES || prefixBytes + size > MAX_PREFIX_BYTES) return null;
        prefix.push(await cur.read(size));
        prefixBytes += size;
      } else if (!(await cur.skip(size))) break;
      pos += size;
      usable = pos;
    }
    if (!moov || !info || !lastMoof) return null;
    // A moof whose media data never made it to the file isn't playable: leave it out.
    if (lastMoof.end === usable) {
      usable = lastMoof.off;
      for (const t of info.tracks.values()) t.fragments = t.fragments.filter((f) => f.moofOffset < usable);
    }
    const { movieTimescale, tracks, mvex } = info;
    const seconds = Math.max(...[...tracks.values()].map((t) => t.end / t.timescale));
    if (!Number.isFinite(seconds) || seconds <= 0 || ![...tracks.values()].some((t) => t.fragments.length)) return null;

    // Track durations in moov → 0; mehd (version 1, 64-bit) with the total at the start of mvex.
    const zero = (box: Box, v1Offset: number, v0Offset: number) => {
      if (moov![box.off + 8] === 1) moov!.writeBigUInt64BE(0n, box.off + v1Offset);
      else moov!.writeUInt32BE(0, box.off + v0Offset);
    };
    for (const t of tracks.values()) {
      zero(t.tkhd, 36, 28);
      zero(t.mdhd, 32, 24);
    }
    const mehd = Buffer.alloc(20);
    mehd.writeUInt32BE(20, 0);
    mehd.write("mehd", 4, "latin1");
    mehd.writeUInt32BE(0x01000000, 8);
    mehd.writeBigUInt64BE(BigInt(Math.round(seconds * movieTimescale)), 12);
    const at = mvex!.off + mvex!.header;
    const newMoov = Buffer.concat([moov.subarray(0, at), mehd, moov.subarray(at)]);
    newMoov.writeUInt32BE(moov.length + 20, 0);
    newMoov.writeUInt32BE(mvex!.size + 20, mvex!.off);
    const header = Buffer.concat([...prefix, newMoov]);
    const headerEnd = moovOff + moov.length;
    const shift = header.length - headerEnd;

    // mfra = one tfra per track (version 1: 64-bit time and offset; traf/trun/sample numbers 1 byte each) + mfro.
    const tfras = [...tracks.values()]
      .filter((t) => t.fragments.length)
      .map((t) => {
        const b = Buffer.alloc(24 + t.fragments.length * 19);
        b.writeUInt32BE(b.length, 0);
        b.write("tfra", 4, "latin1");
        b.writeUInt32BE(0x01000000, 8);
        b.writeUInt32BE(t.id, 12);
        b.writeUInt32BE(0, 16);
        b.writeUInt32BE(t.fragments.length, 20);
        t.fragments.forEach((f, i) => {
          const p = 24 + i * 19;
          b.writeBigUInt64BE(BigInt(f.time), p);
          b.writeBigUInt64BE(BigInt(f.moofOffset + shift), p + 8);
          b[p + 16] = 1;
          b[p + 17] = 1;
          b[p + 18] = 1;
        });
        return b;
      });
    const mfraSize = 8 + tfras.reduce((n, b) => n + b.length, 0) + 16;
    const mfraHead = Buffer.alloc(8);
    mfraHead.writeUInt32BE(mfraSize, 0);
    mfraHead.write("mfra", 4, "latin1");
    const mfro = Buffer.alloc(16);
    mfro.writeUInt32BE(16, 0);
    mfro.write("mfro", 4, "latin1");
    mfro.writeUInt32BE(mfraSize, 12);
    return { header, headerEnd, tail: Buffer.concat([mfraHead, ...tfras, mfro]), usableSize: usable, durationMs: Math.round(seconds * 1000) };
  } finally {
    await cur.close(pos >= totalSize);
  }
}

/** The repaired file, as a stream: new header, the original bytes after its moov, the index. */
export async function* repairedFile(plan: IndexPlan, middle: ByteSource): AsyncGenerator<Uint8Array> {
  yield plan.header;
  let sent = 0;
  const want = plan.usableSize - plan.headerEnd;
  for await (const chunk of iterate(middle)) {
    if (sent + chunk.length > want) {
      yield chunk.subarray(0, want - sent);
      sent = want;
      break;
    }
    sent += chunk.length;
    yield chunk;
  }
  if (sent !== want) throw new Error(`the file changed while it was being read (${sent} of ${want} bytes)`);
  yield plan.tail;
}

export const repairedSize = (plan: IndexPlan) => plan.header.length + (plan.usableSize - plan.headerEnd) + plan.tail.length;
