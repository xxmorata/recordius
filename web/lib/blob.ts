import { del, issueSignedToken, list, presignUrl, put, type IssuedSignedToken } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";

/*
 * All files live in a PRIVATE Vercel Blob store. Nothing is reachable by URL alone:
 *  - the desktop app uploads with a token that can only write one video's own files;
 *  - viewers get presigned URLs that expire, issued only after the access check in lib/videos.
 */

const MAX_VIDEO_BYTES = 20 * 1024 ** 3;
const UPLOAD_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const READ_DELEGATION_TTL_MS = 60 * 60 * 1000;
export const VIEW_URL_TTL_MS = 6 * 60 * 60 * 1000;

function rwToken(): string {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  return t;
}

export function videoPath(id: string, secret: string, ext: string) {
  return `videos/${id}/${secret}/video.${ext}`;
}
export function thumbPath(id: string, secret: string) {
  return `videos/${id}/${secret}/thumb.jpg`;
}
export function customThumbPath(id: string, secret: string, nonce: string) {
  return `videos/${id}/${secret}/thumb-${nonce}.jpg`;
}
export function avatarPath(userId: string, nonce: string) {
  return `avatars/${userId}/${nonce}.jpg`;
}

export async function uploadTokens(id: string, secret: string, ext: string) {
  const validUntil = Date.now() + UPLOAD_TOKEN_TTL_MS;
  const video = videoPath(id, secret, ext);
  const thumb = thumbPath(id, secret);
  const [videoToken, thumbToken] = await Promise.all([
    generateClientTokenFromReadWriteToken({
      token: rwToken(),
      pathname: video,
      allowedContentTypes: ["video/*"],
      maximumSizeInBytes: MAX_VIDEO_BYTES,
      validUntil,
      addRandomSuffix: false,
      allowOverwrite: true,
    }),
    generateClientTokenFromReadWriteToken({
      token: rwToken(),
      pathname: thumb,
      allowedContentTypes: ["image/jpeg"],
      maximumSizeInBytes: 5 * 1024 ** 2,
      validUntil,
      addRandomSuffix: false,
      allowOverwrite: true,
    }),
  ]);
  return { videoPathname: video, videoToken, thumbPathname: thumb, thumbToken, access: "private" as const };
}

declare global {
  var __recordiusReadDelegation: Promise<IssuedSignedToken> | undefined;
}

/** One store-wide read delegation, refreshed well before it expires; presigning itself is local. */
async function readDelegation(): Promise<IssuedSignedToken> {
  const pending = globalThis.__recordiusReadDelegation;
  if (pending) {
    const current = await pending.catch(() => null);
    if (current && current.validUntil - Date.now() > READ_DELEGATION_TTL_MS / 4) return current;
  }
  const next = issueSignedToken({
    token: rwToken(),
    pathname: "*",
    operations: ["get", "head"],
    validUntil: Date.now() + READ_DELEGATION_TTL_MS,
  });
  globalThis.__recordiusReadDelegation = next;
  return next;
}

/** Presigned, expiring URL for a private file. Never call this before checking access. */
export async function viewUrl(pathname: string, ttlMs = VIEW_URL_TTL_MS): Promise<string> {
  const delegation = await readDelegation();
  const { presignedUrl } = await presignUrl(delegation, {
    access: "private",
    operation: "get",
    pathname,
    validUntil: Math.min(Date.now() + ttlMs, delegation.validUntil),
  });
  return presignedUrl;
}

export function downloadUrl(presigned: string): string {
  return `${presigned}${presigned.includes("?") ? "&" : "?"}download=1`;
}

export async function putPrivate(pathname: string, body: Buffer | string, contentType: string) {
  return put(pathname, body, { access: "private", token: rwToken(), contentType, addRandomSuffix: false, allowOverwrite: true });
}

export async function deletePrefix(prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000, token: rwToken() });
    if (page.blobs.length) await del(page.blobs.map((b) => b.url), { token: rwToken() });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

export async function fileExists(pathname: string): Promise<boolean> {
  const page = await list({ prefix: pathname, limit: 1, token: rwToken() });
  return page.blobs.some((b) => b.pathname === pathname);
}

export async function deleteFile(pathname: string) {
  await del(pathname, { token: rwToken() });
}
