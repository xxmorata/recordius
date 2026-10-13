const fs = require("node:fs");
const { createMultipartUpload, uploadPart, completeMultipartUpload, put } = require("@vercel/blob/client");

// Blob multipart parts must be >= 5 MB except the last one; fixed-size parts keep that simple.
const PART_SIZE = 5 * 1024 * 1024;
const MAX_PARALLEL = 3;

async function withRetry(label, fn, attempts = 6) {
  let delay = 500;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`[uploader] ${label} failed (attempt ${i}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 8000);
    }
  }
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
  constructor({ pathname, token, access = "private", contentType, localPath }) {
    this.pathname = pathname;
    this.token = token;
    this.access = access;
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

  get opts() {
    return { access: this.access, token: this.token, contentType: this.contentType };
  }

  async #init() {
    try {
      this.mpu = await withRetry("createMultipartUpload", () => createMultipartUpload(this.pathname, this.opts), 3);
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
    while (this.pendingBytes >= PART_SIZE) this.#enqueue(this.#take(PART_SIZE));
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
          return withRetry(`part ${job.partNumber}`, () =>
            uploadPart(this.pathname, job.body, { ...this.opts, uploadId: this.mpu.uploadId, key: this.mpu.key, partNumber: job.partNumber }),
          ).then((part) => this.parts.push(part));
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
    return this.parts.length * PART_SIZE;
  }

  async finish(onProgress) {
    await new Promise((resolve, reject) => this.file.end((err) => (err ? reject(err) : resolve())));
    await this.ready;
    if (this.live && this.pendingBytes > 0) this.#enqueue(this.#take(this.pendingBytes));
    await this.#drain();

    if (this.live && this.parts.length) {
      const parts = [...this.parts].sort((a, b) => a.partNumber - b.partNumber);
      return withRetry("completeMultipartUpload", () =>
        completeMultipartUpload(this.pathname, parts, { ...this.opts, uploadId: this.mpu.uploadId, key: this.mpu.key }),
      );
    }
    return this.uploadLocalFile(onProgress);
  }

  /** Fallback / recovery path: upload the whole local recording in one multipart put. */
  uploadLocalFile(onProgress) {
    return withRetry(
      "put local file",
      () =>
        put(this.pathname, fs.createReadStream(this.localPath), {
          ...this.opts,
          multipart: true,
          onUploadProgress: onProgress ? (e) => onProgress(e.percentage) : undefined,
        }),
      4,
    );
  }

  abort() {
    this.live = false;
    this.queue = [];
    this.file.destroy();
  }
}

async function uploadThumbnail({ pathname, token, access = "private" }, jpeg) {
  return withRetry("thumbnail", () => put(pathname, jpeg, { access, token, contentType: "image/jpeg" }));
}

module.exports = { LiveUploader, uploadThumbnail, PART_SIZE };
