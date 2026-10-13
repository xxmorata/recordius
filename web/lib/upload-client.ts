"use client";

import { put } from "@vercel/blob/client";
import type { UploadGrant } from "./storage/types";

/*
 * Browser uploads for every storage provider:
 *  - vercel-blob: straight to the store with the per-video client tokens from the grant;
 *  - s3 / local: in parts, each PUT to a signed URL from POST /api/videos/:id/upload.
 */

type Progress = (fraction: number) => void;
const PARALLEL = 4;

async function uploadApi<T>(videoId: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/videos/${videoId}/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Upload failed (${res.status})`);
  return data as T;
}

async function putWithRetry(url: string, body: Blob, signal?: AbortSignal, headers?: Record<string, string>): Promise<Response> {
  let delay = 600;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body, signal, headers });
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`The storage refused the upload (${res.status})`), { fatal: true });
      throw new Error(`The storage answered ${res.status}`);
    } catch (err) {
      if (signal?.aborted || (err as { fatal?: boolean }).fatal || attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

async function multipartUpload(videoId: string, grant: Extract<UploadGrant, { provider: "s3" | "local" }>, file: Blob, signal?: AbortSignal, onProgress?: Progress) {
  const partSize = grant.partSize;
  const count = Math.max(1, Math.ceil(file.size / partSize));
  const { uploadId } = await uploadApi<{ uploadId: string }>(videoId, { op: "create", file: "video" }, signal);
  const etags: string[] = new Array(count);
  const sent: number[] = new Array(count).fill(0);
  let next = 0;
  const batches = new Map<number, Promise<Record<string, string>>>();

  // Signed URLs are fetched 50 at a time (one request per batch, shared by the parallel workers).
  async function urlFor(n: number) {
    const b = Math.floor((n - 1) / 50);
    if (!batches.has(b)) {
      const partNumbers = Array.from({ length: Math.min(50, count - b * 50) }, (_, i) => b * 50 + i + 1);
      batches.set(b, uploadApi<{ urls: Record<string, string> }>(videoId, { op: "parts", file: "video", uploadId, partNumbers }, signal).then((r) => r.urls));
    }
    return (await batches.get(b)!)[n];
  }

  async function worker() {
    for (let i = next++; i < count; i = next++) {
      const chunk = file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize));
      const res = await putWithRetry(await urlFor(i + 1), chunk, signal);
      const etag = res.headers.get("etag");
      if (!etag) throw new Error("The storage didn't return an ETag. Its CORS rule must expose the ETag header (see docs/self-hosting.md#storage).");
      etags[i] = etag;
      sent[i] = chunk.size;
      onProgress?.(sent.reduce((a, b) => a + b, 0) / (file.size || 1));
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, count) }, worker));
  await uploadApi(videoId, { op: "complete", file: "video", uploadId, parts: etags.map((etag, i) => ({ partNumber: i + 1, etag })) }, signal);
}

export async function uploadVideoFile(videoId: string, grant: UploadGrant, file: Blob, contentType: string, signal?: AbortSignal, onProgress?: Progress) {
  if (grant.provider === "vercel-blob") {
    await put(grant.videoPathname, file, {
      access: "private",
      token: grant.videoToken,
      contentType,
      multipart: file.size > 8 * 1024 ** 2,
      abortSignal: signal,
      onUploadProgress: onProgress ? (e) => onProgress(e.percentage / 100) : undefined,
    });
  } else await multipartUpload(videoId, grant, file, signal, onProgress);
}

export async function uploadThumbnail(videoId: string, grant: UploadGrant, jpeg: Blob, signal?: AbortSignal) {
  if (grant.provider === "vercel-blob") {
    await put(grant.thumbPathname, jpeg, { access: "private", token: grant.thumbToken, contentType: "image/jpeg", abortSignal: signal });
    return;
  }
  const { url, contentType } = await uploadApi<{ url: string; contentType: string }>(videoId, { op: "put", file: "thumb" }, signal);
  await putWithRetry(url, jpeg, signal, { "content-type": contentType });
}
