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
}
