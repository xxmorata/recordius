const fs = require("node:fs");
const { createMultipartUpload, uploadPart, completeMultipartUpload, put } = require("@vercel/blob/client");

const MAX_PARALLEL = 3;

async function withRetry(label, fn, attempts = 6) {
  let delay = 500;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || err.fatal) throw err;
      console.warn(`[uploader] ${label} failed (attempt ${i}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 8000);
    }
  }
}

/**
 * Where one video's files go. The server's upload grant says how:
 *  - "vercel-blob" (or no provider: servers before 1.0.7): straight to Vercel Blob with scoped client tokens;
 *  - "s3" / "local": in parts, each PUT to a signed URL from POST /api/videos/:id/upload.
 * @param {object} grant  the `upload` object from POST /api/videos or /upload-token
 * @param {string} videoId
 * @param {(id: string, body: object) => Promise<any>} uploadApi  calls POST /api/videos/:id/upload
 */
function uploadTarget(grant, videoId, uploadApi) {
  if (grant.provider === "s3" || grant.provider === "local") return partsTarget(grant, videoId, uploadApi);
  return blobTarget(grant);
}

function blobTarget(grant) {
  const opts = (contentType) => ({ access: grant.access ?? "private", token: grant.videoToken, contentType });
  return {
    // Blob multipart parts must be >= 5 MB except the last one.
    partSize: 5 * 1024 * 1024,
    async create(contentType) {
      return createMultipartUpload(grant.videoPathname, opts(contentType));
    },
    async uploadPart(mpu, partNumber, body, contentType) {
      return uploadPart(grant.videoPathname, body, { ...opts(contentType), uploadId: mpu.uploadId, key: mpu.key, partNumber });
    },
    async complete(mpu, parts, contentType) {
      await completeMultipartUpload(grant.videoPathname, parts, { ...opts(contentType), uploadId: mpu.uploadId, key: mpu.key });
    },
    async putFile(localPath, contentType, onProgress) {
      await put(grant.videoPathname, fs.createReadStream(localPath), {
        ...opts(contentType),
        multipart: true,
        onUploadProgress: onProgress ? (e) => onProgress(e.percentage) : undefined,
      });
    },
    async putThumbnail(jpeg) {
      await put(grant.thumbPathname, jpeg, { access: grant.access ?? "private", token: grant.thumbToken, contentType: "image/jpeg" });
    },
  };
}

async function putSigned(url, body, headers) {
  let res;
  try {
    res = await fetch(url, { method: "PUT", body, headers });
  } catch (err) {
    throw new Error(`Can't reach the storage (${err.cause?.code ?? err.message})`);
  }
  if (!res.ok) {
    const err = new Error(`The storage refused the upload (${res.status})`);
    if (res.status < 500 && res.status !== 429 && res.status !== 408) err.fatal = res.status !== 403; // 403: URL expired — a fresh one may work
    throw err;
  }
  return res;
}

function partsTarget(grant, videoId, uploadApi) {
  const urls = new Map(); // `${uploadId}:${n}` → signed URL
  async function urlFor(uploadId, n) {
    const key = `${uploadId}:${n}`;
    if (!urls.has(key)) {
      const partNumbers = Array.from({ length: 20 }, (_, i) => n + i).filter((x) => x <= 10000);
      const r = await uploadApi(videoId, { op: "parts", file: "video", uploadId, partNumbers });
      for (const [k, url] of Object.entries(r.urls)) urls.set(`${uploadId}:${k}`, url);
    }
    return urls.get(key);
  }
  const target = {
    partSize: grant.partSize || 8 * 1024 * 1024,
    async create() {
      const { uploadId } = await uploadApi(videoId, { op: "create", file: "video" });
      return { uploadId };
    },
    async uploadPart(mpu, partNumber, body) {
      let url = await urlFor(mpu.uploadId, partNumber);
      try {
        const res = await putSigned(url, body);
        return { partNumber, etag: etagOf(res) };
      } catch (err) {
        if (!/\(403\)/.test(err.message)) throw err;
        urls.delete(`${mpu.uploadId}:${partNumber}`); // expired (12 h recordings…): sign again
        url = await urlFor(mpu.uploadId, partNumber);
        const res = await putSigned(url, body);
        return { partNumber, etag: etagOf(res) };
      }
    },
    async complete(mpu, parts) {
      await uploadApi(videoId, { op: "complete", file: "video", uploadId: mpu.uploadId, parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })) });
    },
    async putFile(localPath, _contentType, onProgress) {
      const size = fs.statSync(localPath).size;
      const count = Math.max(1, Math.ceil(size / target.partSize));
      const mpu = await target.create();
      const parts = new Array(count);
      let next = 0;
      let done = 0;
      const fd = fs.openSync(localPath, "r");
      try {
        const worker = async () => {
          for (let i = next++; i < count; i = next++) {
            const length = Math.min(target.partSize, size - i * target.partSize);
            const buf = Buffer.alloc(Math.max(0, length));
            fs.readSync(fd, buf, 0, buf.length, i * target.partSize);
            parts[i] = await withRetry(`part ${i + 1}`, () => target.uploadPart(mpu, i + 1, buf));
            done += buf.length;
            onProgress?.((done / (size || 1)) * 100);
          }
        };
        await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, count) }, worker));
      } finally {
        fs.closeSync(fd);
      }
      await withRetry("complete", () => target.complete(mpu, parts));
    },
    async putThumbnail(jpeg) {
      const { url, contentType } = await uploadApi(videoId, { op: "put", file: "thumb" });
      await putSigned(url, jpeg, { "content-type": contentType });
    },
  };
  return target;
}

function etagOf(res) {
  const etag = res.headers.get("etag");
  if (!etag) throw Object.assign(new Error("The storage didn't return an ETag for an upload part"), { fatal: true });
  return etag;
}

/**
 * Uploads a recording *while it is being recorded*, the way Loom's HLS uploader does:
 * MediaRecorder chunks are written to a local file (recovery copy) and also packed into
 * fixed-size multipart parts that are uploaded immediately. Stopping only flushes the tail.
 *
 * If the live upload breaks (offline, token problems), recording continues locally and
 * finish() falls back to uploading the whole local file.
 */
class LiveUploader {
  constructor({ target, contentType, localPath }) {
    this.target = target;
    this.partSize = target.partSize;
    this.contentType = contentType;
    this.localPath = localPath;
    this.file = fs.createWriteStream(localPath);
    this.pending = [];
    this.pendingBytes = 0;
    this.totalBytes = 0;
    this.nextPart = 1;
    this.parts = [];
    this.inflight = new Set();
    this.queue = [];
    this.live = true;
    this.liveError = null;
    this.ready = this.#init();
  }

  async #init() {
    try {
      this.mpu = await withRetry("create multipart upload", () => this.target.create(this.contentType), 3);
    } catch (err) {
      this.#goOffline(err);
    }
  }

  #goOffline(err) {
    if (!this.live) return;
    this.live = false;
    this.liveError = err;
    console.warn(`[uploader] live upload disabled, will upload local file at the end: ${err.message}`);
  }

  push(buf) {
    this.file.write(buf);
    this.totalBytes += buf.length;
    if (!this.live) return;
    this.pending.push(buf);
    this.pendingBytes += buf.length;
    while (this.pendingBytes >= this.partSize) this.#enqueue(this.#take(this.partSize));
  }

  #take(n) {
    const all = Buffer.concat(this.pending);
    const part = all.subarray(0, n);
    const rest = all.subarray(n);
    this.pending = rest.length ? [rest] : [];
    this.pendingBytes = rest.length;
    return part;
  }

  #enqueue(body) {
    this.queue.push({ partNumber: this.nextPart++, body });
    this.#pump();
  }

  #pump() {
    while (this.live && this.inflight.size < MAX_PARALLEL && this.queue.length) {
      const job = this.queue.shift();
      const p = this.ready
        .then(() => {
          if (!this.live) return;
          return withRetry(`part ${job.partNumber}`, () => this.target.uploadPart(this.mpu, job.partNumber, job.body, this.contentType)).then((part) => this.parts.push(part));
        })
        .catch((err) => this.#goOffline(err))
        .finally(() => {
          this.inflight.delete(p);
          this.#pump();
        });
      this.inflight.add(p);
    }
  }

  async #drain() {
    while (this.inflight.size || (this.live && this.queue.length)) {
      await Promise.all([...this.inflight]);
    }
  }

  /** Bytes confirmed uploaded so far (for progress). */
  get uploadedBytes() {
    return this.parts.length * this.partSize;
  }

  async finish(onProgress) {
    await new Promise((resolve, reject) => this.file.end((err) => (err ? reject(err) : resolve())));
    await this.ready;
    if (this.live && this.pendingBytes > 0) this.#enqueue(this.#take(this.pendingBytes));
    await this.#drain();

    if (this.live && this.parts.length) {
      const parts = [...this.parts].sort((a, b) => a.partNumber - b.partNumber);
      return withRetry("complete multipart upload", () => this.target.complete(this.mpu, parts, this.contentType));
    }
    return this.uploadLocalFile(onProgress);
  }

  /** Fallback / recovery path: upload the whole local recording. */
  uploadLocalFile(onProgress) {
    return withRetry("upload local file", () => this.target.putFile(this.localPath, this.contentType, onProgress), 4);
  }

  abort() {
    this.live = false;
    this.queue = [];
    this.file.destroy();
  }
}

/** Uploads a whole file from disk (retried). Used for retries after a failed upload. */
function uploadFile(target, localPath, contentType, onProgress) {
  return withRetry("upload local file", () => target.putFile(localPath, contentType, onProgress), 4);
}

async function uploadThumbnail(target, jpeg) {
  return withRetry("thumbnail", () => target.putThumbnail(jpeg));
}

module.exports = { LiveUploader, uploadTarget, uploadFile, uploadThumbnail };
