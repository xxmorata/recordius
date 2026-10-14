import { createMultipartUploader, del, issueSignedToken, list, presignUrl, put, type IssuedSignedToken } from "@vercel/blob";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { stableWindow, uploadInParts, type StorageDriver } from "./types";

/* A PRIVATE Vercel Blob store. The desktop app and the browser upload with client tokens scoped to one
 * video's own files (see uploadGrant in ../blob.ts); reads are presigned from one store-wide delegation. */

// Long enough that every URL presigned from it can get its full lifetime (VIEW_URL_TTL_MS, 6 h): it is
// renewed once less than 7 h are left, so a new URL is never cut short by an expiring delegation.
const READ_DELEGATION_TTL_MS = 12 * 60 * 60 * 1000;
const READ_DELEGATION_RENEW_MS = 7 * 60 * 60 * 1000;

export function blobToken(): string {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  return t;
}

declare global {
  var __recordiusReadDelegation: Promise<IssuedSignedToken> | undefined;
}

/** One store-wide read delegation, refreshed well before it expires; presigning itself is local. */
async function readDelegation(): Promise<IssuedSignedToken> {
  const pending = globalThis.__recordiusReadDelegation;
  if (pending) {
    const current = await pending.catch(() => null);
    if (current && current.validUntil - Date.now() > READ_DELEGATION_RENEW_MS) return current;
  }
  const next = issueSignedToken({ token: blobToken(), pathname: "*", operations: ["get", "head"], validUntil: Date.now() + READ_DELEGATION_TTL_MS });
  globalThis.__recordiusReadDelegation = next;
  return next;
}

export const vercelBlob: StorageDriver = {
  provider: "vercel-blob",
  async viewUrl(pathname, ttlMs, downloadName) {
    const delegation = await readDelegation();
    const { presignedUrl } = await presignUrl(delegation, {
      access: "private",
      operation: "get",
      pathname,
      validUntil: Math.min(stableWindow(ttlMs).expiresAt, delegation.validUntil),
    });
    return downloadName ? `${presignedUrl}${presignedUrl.includes("?") ? "&" : "?"}download=1` : presignedUrl;
  },
  async put(pathname, body, contentType) {
    await put(pathname, body, { access: "private", token: blobToken(), contentType, addRandomSuffix: false, allowOverwrite: true });
  },
  async exists(pathname) {
    return (await vercelBlob.size(pathname)) !== null;
  },
  async size(pathname) {
    const page = await list({ prefix: pathname, limit: 1, token: blobToken() });
    return page.blobs.find((b) => b.pathname === pathname)?.size ?? null;
  },
  async deleteFile(pathname) {
    await del(pathname, { token: blobToken() });
  },
  async deletePrefix(prefix) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000, token: blobToken() });
      if (page.blobs.length) await del(page.blobs.map((b) => b.url), { token: blobToken() });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  },
  async readStream(pathname, range) {
    // Node's own HTTP client rather than fetch: inside a Next.js request (and its after() work) the global
    // fetch is instrumented, and reading a large body through it was many times slower.
    const url = await vercelBlob.viewUrl(pathname, 60 * 60 * 1000);
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      https.get(url, { headers: range ? { range: `bytes=${range.start}-${range.end}`, "cache-control": "no-cache" } : { "cache-control": "no-cache" } }, resolve).on("error", reject);
    });
    if (res.statusCode !== (range ? 206 : 200)) {
      res.resume();
      throw new Error(`reading ${pathname} from Vercel Blob failed (${res.statusCode})`);
    }
    return Readable.toWeb(res) as ReadableStream<Uint8Array>;
  },
  async putStream(pathname, body, contentType) {
    // Explicit parts (8 MB each, one at a time): bounded memory, and it finishes for files smaller than a
    // part too, which put(stream, { multipart: true }) doesn't reliably do.
    const uploader = await createMultipartUploader(pathname, { access: "private", token: blobToken(), contentType, addRandomSuffix: false, allowOverwrite: true });
    const parts = await uploadInParts(body, (n, part) => uploader.uploadPart(n, part));
    await uploader.complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
  },
};
