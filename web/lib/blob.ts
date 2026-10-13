import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { local } from "./storage/local";
import { s3 } from "./storage/s3";
import type { StorageDriver, StorageProvider, UploadGrant, UploadedPart } from "./storage/types";
import { blobToken, vercelBlob } from "./storage/vercel-blob";

/*
 * Where files live is up to the person running Recordius (see docs/self-hosting.md):
 *  - STORAGE=local   — a folder on this server (default outside Vercel; STORAGE_DIR, /data in Docker)
 *  - STORAGE=s3      — any S3-compatible bucket (S3_BUCKET, S3_ENDPOINT, keys…)
 *  - STORAGE=vercel-blob — a private Vercel Blob store (BLOB_READ_WRITE_TOKEN)
 * Without STORAGE, the provider is picked from whichever of those is configured.
 * In every case files are private: uploads are scoped to one video and reads use expiring signed URLs
 * that are only issued after the access check in lib/videos.
 */

export const MAX_VIDEO_BYTES = 20 * 1024 ** 3;
export const UPLOAD_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const VIEW_URL_TTL_MS = 6 * 60 * 60 * 1000;
/** Parts for s3/local uploads (S3 needs ≥ 5 MB except for the last part). */
export const PART_SIZE = 8 * 1024 ** 2;

export function storageProvider(): StorageProvider {
  const explicit = process.env.STORAGE?.trim().toLowerCase();
  if (explicit === "s3" || explicit === "local" || explicit === "vercel-blob") return explicit;
  if (explicit === "blob" || explicit === "vercel") return "vercel-blob";
  if (explicit) throw new Error(`Unknown STORAGE "${process.env.STORAGE}" — use local, s3 or vercel-blob`);
  if (process.env.S3_BUCKET) return "s3";
  if (process.env.BLOB_READ_WRITE_TOKEN) return "vercel-blob";
  if (process.env.VERCEL) throw new Error("No storage configured: on Vercel, connect a Blob store (BLOB_READ_WRITE_TOKEN) or set S3_BUCKET");
  return "local";
}

export function storage(): StorageDriver {
  const p = storageProvider();
  return p === "s3" ? s3 : p === "local" ? local : vercelBlob;
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

/** What a client needs to upload one video's files (recorder, browser upload, retries). */
export async function uploadGrant(id: string, secret: string, ext: string): Promise<UploadGrant> {
  const video = videoPath(id, secret, ext);
  const thumb = thumbPath(id, secret);
  const provider = storageProvider();
  if (provider !== "vercel-blob") return { provider, access: "private", videoPathname: video, thumbPathname: thumb, partSize: PART_SIZE };
  const validUntil = Date.now() + UPLOAD_TOKEN_TTL_MS;
  const [videoToken, thumbToken] = await Promise.all([
    generateClientTokenFromReadWriteToken({
      token: blobToken(),
      pathname: video,
      allowedContentTypes: ["video/*"],
      maximumSizeInBytes: MAX_VIDEO_BYTES,
      validUntil,
      addRandomSuffix: false,
      allowOverwrite: true,
    }),
    generateClientTokenFromReadWriteToken({
      token: blobToken(),
      pathname: thumb,
      allowedContentTypes: ["image/jpeg"],
      maximumSizeInBytes: 5 * 1024 ** 2,
      validUntil,
      addRandomSuffix: false,
      allowOverwrite: true,
    }),
  ]);
  return { provider: "vercel-blob", access: "private", videoPathname: video, videoToken, thumbPathname: thumb, thumbToken };
}

/** Signed, expiring URL for a private file. Never call this before checking access. */
export function viewUrl(pathname: string, ttlMs = VIEW_URL_TTL_MS): Promise<string> {
  return storage().viewUrl(pathname, ttlMs);
}

/** Like viewUrl, but the browser saves the file as `filename`. */
export function downloadUrl(pathname: string, filename: string, ttlMs = VIEW_URL_TTL_MS): Promise<string> {
  return storage().viewUrl(pathname, ttlMs, filename);
}

export function putPrivate(pathname: string, body: Buffer, contentType: string) {
  return storage().put(pathname, body, contentType);
}

export function deletePrefix(prefix: string) {
  return storage().deletePrefix(prefix);
}

export function fileExists(pathname: string) {
  return storage().exists(pathname);
}

export function fileSize(pathname: string) {
  return storage().size(pathname);
}

export function deleteFile(pathname: string) {
  return storage().deleteFile(pathname);
}

// ───────── uploads through signed part URLs (s3 / local) ─────────

function partsDriver(): Required<Pick<StorageDriver, "createMultipart" | "partUrl" | "completeMultipart" | "putUrl">> {
  const d = storage();
  if (!d.createMultipart || !d.partUrl || !d.completeMultipart || !d.putUrl) throw new Error(`Uploads through Recordius aren't used with ${d.provider}`);
  return d as Required<StorageDriver>;
}

export const startMultipart = (pathname: string, contentType: string) => partsDriver().createMultipart(pathname, contentType);
export const partUrl = (pathname: string, uploadId: string, partNumber: number) => partsDriver().partUrl(pathname, uploadId, partNumber, UPLOAD_TOKEN_TTL_MS);
export const finishMultipart = (pathname: string, uploadId: string, parts: UploadedPart[]) => partsDriver().completeMultipart(pathname, uploadId, parts);
export const singlePutUrl = (pathname: string, contentType: string) => partsDriver().putUrl(pathname, contentType, UPLOAD_TOKEN_TTL_MS);
