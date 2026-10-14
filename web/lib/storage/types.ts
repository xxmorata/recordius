/**
 * Where recordings, thumbnails and avatars are stored. Every driver keeps files private: nothing is
 * readable without a short-lived signed URL that the server issues after its access check.
 */
export type StorageProvider = "vercel-blob" | "s3" | "local";

/** What the desktop app / browser receive to upload one video's files. */
export type UploadGrant =
  | {
      provider: "vercel-blob";
      access: "private";
      videoPathname: string;
      videoToken: string;
      thumbPathname: string;
      thumbToken: string;
    }
  | {
      /** Parts go straight to signed URLs handed out by POST /api/videos/:id/upload. */
      provider: "s3" | "local";
      access: "private";
      videoPathname: string;
      thumbPathname: string;
      /** Minimum part size (except the last part). */
      partSize: number;
    };

export type UploadedPart = { partNumber: number; etag: string };

const HOUR = 60 * 60 * 1000;
/**
 * Signed read links are made identical within each clock hour (expiry rounded up to the next full hour),
 * so browsers can cache thumbnails and avatars instead of downloading them again on every page load.
 * Every link still lives at least `ttlMs`, and at most an hour longer.
 */
export function stableWindow(ttlMs: number, now = Date.now()) {
  const signedAt = Math.floor(now / HOUR) * HOUR;
  const expiresAt = Math.ceil((now + ttlMs) / HOUR) * HOUR;
  return { signedAt, expiresAt };
}

export interface StorageDriver {
  provider: StorageProvider;
  /** Signed, expiring GET URL. `downloadName` makes browsers save the file instead of playing it. */
  viewUrl(pathname: string, ttlMs: number, downloadName?: string): Promise<string>;
  put(pathname: string, body: Buffer, contentType: string): Promise<void>;
  exists(pathname: string): Promise<boolean>;
  /** Size in bytes, or null when the file doesn't exist. */
  size(pathname: string): Promise<number | null>;
  deleteFile(pathname: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Multipart upload with client-side part uploads (s3 / local). */
  createMultipart?(pathname: string, contentType: string): Promise<string>;
  partUrl?(pathname: string, uploadId: string, partNumber: number, ttlMs: number): Promise<string>;
  completeMultipart?(pathname: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  /** Single signed PUT (thumbnails). The client must send the same Content-Type. */
  putUrl?(pathname: string, contentType: string, ttlMs: number): Promise<string>;
  /** The file's bytes (or an inclusive byte range), streamed. Used server side to repair recordings. */
  readStream(pathname: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>>;
  /** Writes a file of any size from a stream (multipart where the storage needs it). */
  putStream(pathname: string, body: AsyncIterable<Uint8Array>, contentType: string): Promise<void>;
}

/**
 * Cuts a byte stream into 8 MB parts (S3 wants ≥ 5 MB except for the last) and uploads them, three at a
 * time: bounded memory, and far faster than one by one. Returns the parts in order.
 */
export async function uploadInParts(body: AsyncIterable<Uint8Array>, upload: (partNumber: number, part: Buffer) => Promise<UploadedPart>): Promise<UploadedPart[]> {
  const PART = 8 * 1024 ** 2;
  const PARALLEL = 3;
  const results: UploadedPart[] = [];
  const inflight = new Map<number, Promise<void>>();
  let failed: unknown = null;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let next = 1;
  const start = async (part: Buffer) => {
    if (failed) throw failed;
    const n = next++;
    // Failures are recorded, never left as unhandled rejections, and thrown from the main flow below.
    const p = upload(n, part).then(
      (r) => {
        results[n - 1] = r;
      },
      (err) => {
        failed ??= err;
      },
    ).finally(() => inflight.delete(n));
    inflight.set(n, p);
    if (inflight.size >= PARALLEL) await Promise.race(inflight.values());
    if (failed) throw failed;
  };
  for await (const chunk of body) {
    pending.push(Buffer.from(chunk));
    pendingBytes += chunk.length;
    if (pendingBytes >= PART) {
      const all = Buffer.concat(pending);
      pending = all.length > PART ? [all.subarray(PART)] : [];
      pendingBytes = pending.length ? pending[0].length : 0;
      await start(all.subarray(0, PART));
    }
  }
  if (pendingBytes || next === 1) await start(Buffer.concat(pending));
  await Promise.all(inflight.values());
  if (failed) throw failed;
  return results;
}

