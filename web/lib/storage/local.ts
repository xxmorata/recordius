import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { appUrl, authSecret } from "../env";
import type { StorageDriver } from "./types";

/*
 * Files on this server's own disk (a Docker volume, a VPS folder). Nothing is served from the folder
 * directly: every read and write goes through /api/storage with an HMAC-signed, expiring URL that the
 * server only hands out after its access check — the same model as a private bucket.
 */

// Clients send 8 MB parts (PART_SIZE in ../blob.ts) and a smaller last one; a little headroom, never more.
export const MAX_PART_BYTES = 9 * 1024 ** 2;
const MAX_FILE_BYTES = 20 * 1024 ** 3;
export const MAX_PUT_BYTES = 25 * 1024 ** 2;
const MAX_PARTS = 10_000;
const STALE_UPLOAD_MS = 2 * 24 * 60 * 60 * 1000;
const SAFE_PATH = /^(videos|avatars)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const UPLOAD_ID = /^[a-f0-9]{32}$/;

export function storageRoot(): string {
  // The ignore comments keep Next's file tracing from bundling the whole project for these dynamic paths.
  return resolve(/*turbopackIgnore: true*/ process.env.STORAGE_DIR?.trim() || join(/*turbopackIgnore: true*/ process.cwd(), "storage"));
}

/** Absolute path for a stored file; refuses anything that could escape the storage folder. */
function fileFor(pathname: string): string {
  if (!SAFE_PATH.test(pathname) || pathname.split("/").some((s) => s === "." || s === "..")) throw new Error(`Invalid storage path: ${pathname}`);
  const root = storageRoot();
  const full = resolve(/*turbopackIgnore: true*/ root, pathname);
  if (!full.startsWith(root + sep)) throw new Error(`Invalid storage path: ${pathname}`);
  return full;
}

function uploadDir(uploadId: string): string {
  if (!UPLOAD_ID.test(uploadId)) throw new Error("Invalid upload id");
  return join(/*turbopackIgnore: true*/ storageRoot(), ".uploads", uploadId);
}

// ───────── signed URLs ─────────

function sign(...parts: string[]): string {
  return createHmac("sha256", authSecret()).update(`storage\n${parts.join("\n")}`).digest("base64url");
}

function signedUrl(path: string, params: Record<string, string>, signed: string[]): string {
  const q = new URLSearchParams({ ...params, s: sign(...signed) });
  return `${appUrl()}${path}?${q}`;
}

function verify(sig: string | null, expires: string | null, ...parts: string[]): boolean {
  if (!sig || !expires || !/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(...parts, expires));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Checks a /api/storage/file URL; returns the stored file and download name, or null. */
export function verifyRead(q: URLSearchParams): { file: string; pathname: string; downloadName: string | null } | null {
  const pathname = q.get("p") ?? "";
  const dl = q.get("dl");
  if (!verify(q.get("s"), q.get("e"), "get", pathname, dl ?? "")) return null;
  try {
    return { file: fileFor(pathname), pathname, downloadName: dl };
  } catch {
    return null;
  }
}

export type WriteTarget =
  | { kind: "part"; uploadId: string; partNumber: number; sig: string; expires: string }
  | { kind: "put"; pathname: string; contentType: string };

/** Checks a /api/storage/upload URL. */
export function verifyWrite(q: URLSearchParams): WriteTarget | null {
  const u = q.get("u");
  if (u) {
    const n = Number(q.get("n"));
    const sig = q.get("s");
    const expires = q.get("e");
    if (!UPLOAD_ID.test(u) || !Number.isInteger(n) || n < 1 || n > MAX_PARTS || !sig || !expires) return null;
    // The signature also covers the upload's file, which only the upload's own metadata knows: checked in receiveWrite.
    return { kind: "part", uploadId: u, partNumber: n, sig, expires };
  }
  const p = q.get("p") ?? "";
  const ct = q.get("ct") ?? "";
  if (!SAFE_PATH.test(p) || !verify(q.get("s"), q.get("e"), "put", p, ct)) return null;
  return { kind: "put", pathname: p, contentType: ct };
}

// ───────── writes ─────────

/** Streams a request body to disk (temp file + rename), with a size cap. Returns the MD5 (the "ETag"). */
async function writeStream(body: ReadableStream<Uint8Array>, dest: string, maxBytes: number): Promise<string> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
  const md5 = createHash("md5");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new Error(`Too large (max ${Math.round(maxBytes / 1024 ** 2)} MB)`));
      md5.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), meter, createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return md5.digest("hex");
}

export async function receiveWrite(target: WriteTarget, body: ReadableStream<Uint8Array>): Promise<string> {
  if (target.kind === "put") return writeStream(body, fileFor(target.pathname), MAX_PUT_BYTES);
  const dir = uploadDir(target.uploadId);
  const meta = await readMeta(dir); // the upload must exist
  if (!verify(target.sig, target.expires, "part", target.uploadId, String(target.partNumber), meta.pathname)) throw new Error("Forbidden");
  // Keep one file under the size limit, however many parts arrive.
  let stored = 0;
  for (const name of await readdir(dir)) if (name.endsWith(".part") && name !== `${target.partNumber}.part`) stored += (await stat(join(dir, name))).size;
  if (stored > MAX_FILE_BYTES) throw new Error("Too large (max 20480 MB)");
  const etag = await writeStream(body, join(dir, `${target.partNumber}.part`), MAX_PART_BYTES);
  await writeFile(join(dir, `${target.partNumber}.etag`), etag);
  return etag;
}

/** Messages from this driver are shown to people; file-system details (paths…) never are. */
export class StorageError extends Error {}

async function readMeta(dir: string): Promise<{ pathname: string }> {
  try {
    return JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  } catch {
    throw new StorageError("This upload doesn't exist or has expired — start it again");
  }
}

async function removeStaleUploads(pathname?: string) {
  const base = join(/*turbopackIgnore: true*/ storageRoot(), ".uploads");
  const entries = await readdir(base).catch(() => [] as string[]);
  for (const id of entries) {
    const info = await stat(join(base, id)).catch(() => null);
    if (!info) continue;
    // Old leftovers, and earlier unfinished uploads of the same file (a restarted upload replaces them).
    const same = pathname ? await readMeta(join(base, id)).then((m) => m.pathname === pathname, () => false) : false;
    if (same || Date.now() - info.mtimeMs > STALE_UPLOAD_MS) await rm(join(base, id), { recursive: true, force: true });
  }
}

// ───────── driver ─────────

export const local: StorageDriver = {
  provider: "local",
  async viewUrl(pathname, ttlMs, downloadName) {
    fileFor(pathname);
    const e = String(Date.now() + ttlMs);
    const dl = downloadName ?? "";
    return signedUrl("/api/storage/file", { p: pathname, e, ...(dl ? { dl } : {}) }, ["get", pathname, dl, e]);
  },
  async put(pathname, body) {
    const dest = fileFor(pathname);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, dest);
  },
  async exists(pathname) {
    return stat(fileFor(pathname)).then((s) => s.isFile(), () => false);
  },
  async size(pathname) {
    return stat(fileFor(pathname)).then((s) => (s.isFile() ? s.size : null), () => null);
  },
  async deleteFile(pathname) {
    await rm(fileFor(pathname), { force: true });
  },
  async deletePrefix(prefix) {
    const clean = prefix.replace(/\/+$/, "");
    await rm(fileFor(clean), { recursive: true, force: true });
  },
  async createMultipart(pathname, contentType) {
    fileFor(pathname);
    await removeStaleUploads(pathname).catch(() => {});
    const id = randomBytes(16).toString("hex");
    const dir = uploadDir(id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"), JSON.stringify({ pathname, contentType }));
    return id;
  },
  async partUrl(pathname, uploadId, partNumber, ttlMs) {
    uploadDir(uploadId);
    fileFor(pathname);
    const e = String(Date.now() + ttlMs);
    return signedUrl("/api/storage/upload", { u: uploadId, n: String(partNumber), e }, ["part", uploadId, String(partNumber), pathname, e]);
  },
  async completeMultipart(pathname, uploadId, parts) {
    const dir = uploadDir(uploadId);
    const meta = await readMeta(dir);
    if (meta.pathname !== pathname) throw new StorageError("This upload belongs to another file");
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    if (!sorted.length || sorted.some((p, i) => p.partNumber !== i + 1)) throw new StorageError("Parts must be numbered 1, 2, 3… without gaps");
    let total = 0;
    for (const p of sorted) {
      const etag = await readFile(join(dir, `${p.partNumber}.etag`), "utf8").catch(() => null);
      if (!etag || etag !== p.etag.replace(/"/g, "")) throw new StorageError(`Part ${p.partNumber} is missing or different`);
      total += (await stat(join(dir, `${p.partNumber}.part`))).size;
    }
    // Checked before assembling, so an oversized upload never takes twice its size on disk.
    if (total > MAX_FILE_BYTES) {
      await rm(dir, { recursive: true, force: true });
      throw new StorageError("Videos can be up to 20 GB");
    }
    const dest = fileFor(pathname);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const out = createWriteStream(tmp);
      for (const p of sorted) await pipeline(createReadStream(join(dir, `${p.partNumber}.part`)), out, { end: false });
      await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    await rm(dir, { recursive: true, force: true });
  },
  async putUrl(pathname, contentType, ttlMs) {
    fileFor(pathname);
    const e = String(Date.now() + ttlMs);
    return signedUrl("/api/storage/upload", { p: pathname, ct: contentType, e }, ["put", pathname, contentType, e]);
  },
};
