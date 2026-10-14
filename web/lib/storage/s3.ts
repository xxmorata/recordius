import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { stableWindow, uploadInParts, type StorageDriver } from "./types";

/*
 * Any S3-compatible bucket: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, Hetzner, DigitalOcean Spaces,
 * MinIO, Garage, SeaweedFS… The bucket stays private; uploads and playback use presigned URLs.
 */

declare global {
  var __recordiusS3: S3Client | undefined;
}

export function s3Config() {
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) throw new Error("S3_BUCKET is not configured");
  const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
  return {
    bucket,
    endpoint,
    region: process.env.S3_REGION?.trim() || (endpoint ? "auto" : "us-east-1"),
    // MinIO, Garage and most self-hosted servers need path-style URLs (http://host/bucket/key).
    forcePathStyle: /^(1|true|yes)$/i.test(process.env.S3_FORCE_PATH_STYLE ?? ""),
    accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim(),
  };
}

function client(): S3Client {
  if (!globalThis.__recordiusS3) {
    const c = s3Config();
    globalThis.__recordiusS3 = new S3Client({
      region: c.region,
      endpoint: c.endpoint,
      forcePathStyle: c.forcePathStyle,
      credentials: c.accessKeyId && c.secretAccessKey ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } : undefined,
      // Some S3-compatible servers reject the newer default checksums on presigned uploads.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return globalThis.__recordiusS3;
}

const bucket = () => s3Config().bucket;

/**
 * DeleteObjects and PutBucketCors must carry a body checksum. Newer AWS SDKs send CRC32 headers, which many
 * S3-compatible servers don't understand (they want the classic Content-MD5) — send Content-MD5 instead.
 * AWS itself accepts both.
 */
function withContentMd5<T extends { middlewareStack: { add: (...a: never[]) => void } }>(command: T): T {
  (command.middlewareStack as unknown as { add: (mw: unknown, opts: unknown) => void }).add(
    (next: (args: unknown) => Promise<unknown>) => async (args: { request?: { body?: unknown; headers?: Record<string, string> } }) => {
      const req = args.request;
      if (req?.headers && (typeof req.body === "string" || req.body instanceof Uint8Array)) {
        for (const h of Object.keys(req.headers)) if (/^x-amz-(checksum-|sdk-checksum-algorithm)/i.test(h)) delete req.headers[h];
        req.headers["content-md5"] = createHash("md5").update(req.body).digest("base64");
      }
      return next(args);
    },
    { step: "build", priority: "low", name: "recordiusContentMd5" },
  );
  return command;
}
const seconds = (ms: number) => Math.max(60, Math.min(Math.floor(ms / 1000), 7 * 24 * 3600)); // S3 allows up to 7 days

function isNotFound(err: unknown) {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

export const s3: StorageDriver = {
  provider: "s3",
  async viewUrl(pathname, ttlMs, downloadName) {
    return getSignedUrl(
      client(),
      new GetObjectCommand({
        Bucket: bucket(),
        Key: pathname,
        ResponseContentDisposition: downloadName ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` : undefined,
      }),
      (() => {
        const { signedAt, expiresAt } = stableWindow(ttlMs);
        return { signingDate: new Date(signedAt), expiresIn: seconds(expiresAt - signedAt) };
      })(),
    );
  },
  async put(pathname, body, contentType) {
    await client().send(new PutObjectCommand({ Bucket: bucket(), Key: pathname, Body: body, ContentType: contentType }));
  },
  async exists(pathname) {
    return (await s3.size(pathname)) !== null;
  },
  async size(pathname) {
    try {
      const r = await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: pathname }));
      return r.ContentLength ?? 0;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },
  async deleteFile(pathname) {
    await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: pathname }));
  },
  async deletePrefix(prefix) {
    let token: string | undefined;
    do {
      const page = await client().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
      const keys = (page.Contents ?? []).map((o) => o.Key!).filter(Boolean);
      if (keys.length) {
        try {
          await client().send(withContentMd5(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } })));
        } catch {
          // A few S3-compatible servers don't implement batch delete.
          for (const Key of keys) await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key }));
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  },
  async createMultipart(pathname, contentType) {
    const r = await client().send(new CreateMultipartUploadCommand({ Bucket: bucket(), Key: pathname, ContentType: contentType }));
    if (!r.UploadId) throw new Error("The storage didn't start the upload");
    return r.UploadId;
  },
  async partUrl(pathname, uploadId, partNumber, ttlMs) {
    return getSignedUrl(client(), new UploadPartCommand({ Bucket: bucket(), Key: pathname, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: seconds(ttlMs) });
  },
  async completeMultipart(pathname, uploadId, parts) {
    await client().send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket(),
        Key: pathname,
        UploadId: uploadId,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  },
  async putUrl(pathname, contentType, ttlMs) {
    return getSignedUrl(client(), new PutObjectCommand({ Bucket: bucket(), Key: pathname, ContentType: contentType }), { expiresIn: seconds(ttlMs) });
  },
  async readStream(pathname, range) {
    const r = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: pathname, Range: range ? `bytes=${range.start}-${range.end}` : undefined }));
    if (!r.Body) throw new Error("empty response from the bucket");
    return r.Body.transformToWebStream();
  },
  async putStream(pathname, body, contentType) {
    // Server-side multipart upload, one 8 MB part at a time (S3 wants ≥ 5 MB except for the last part).
    const Bucket = bucket();
    const Key = pathname;
    const { UploadId } = await client().send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType: contentType }));
    if (!UploadId) throw new Error("The storage didn't start the upload");
    try {
      const parts = await uploadInParts(body, async (PartNumber, Body) => {
        const { ETag } = await client().send(new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body }));
        return { partNumber: PartNumber, etag: ETag ?? "" };
      });
      await client().send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) } }));
    } catch (err) {
      await client().send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })).catch(() => {});
      throw err;
    }
  },
};

/**
 * Browsers upload and play straight from the bucket, so it needs CORS for this app's origin.
 * Best effort on start: some providers only allow CORS changes from their dashboard (see docs).
 */
export async function ensureBucketCors(origin: string) {
  await client().send(
    withContentMd5(new PutBucketCorsCommand({
      Bucket: bucket(),
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [origin],
            AllowedMethods: ["GET", "HEAD", "PUT"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    })),
  );
}
