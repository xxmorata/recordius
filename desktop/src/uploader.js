const fs = require("node:fs");
const http = require("./http");
const mp4 = require("./mp4-index");
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
    res = await http.fetch(url, { method: "PUT", body, headers });
  } catch (err) {
    throw new Error(http.unreachable("the storage", err));
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
        let stop = false;
        const worker = async () => {
          for (let i = next++; i < count && !stop; i = next++) {
            const length = Math.min(target.partSize, size - i * target.partSize);
            const buf = Buffer.alloc(Math.max(0, length));
            fs.readSync(fd, buf, 0, buf.length, i * target.partSize);
            parts[i] = await withRetry(`part ${i + 1}`, () => target.uploadPart(mpu, i + 1, buf)).catch((err) => {
              stop = true;
              throw err;
            });
            done += buf.length;
            onProgress?.((done / (size || 1)) * 100);
          }
        };
        // Let every worker finish before closing the file (a sibling may still be reading).
        const results = await Promise.allSettled(Array.from({ length: Math.min(MAX_PARALLEL, count) }, worker));
        const failed = results.find((r) => r.status === "rejected");
        if (failed) throw failed.reason;
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
 * Built for long recordings on bad networks:
 *  - while recording, a failing part is retried with backoff (up to a minute apart) instead of giving up;
 *  - at most MAX_QUEUED_BYTES of not-yet-uploaded parts stay in memory — later parts are read back
 *    from the local file when their turn comes, so a slow uplink can't grow memory without limit;
 *  - if the live upload still can't finish, finish() uploads the whole local file instead.
 */
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const LIVE_RETRY_MAX_DELAY = 60000;
const FINISH_ATTEMPTS = 6;

class LiveUploader {
  constructor({ target, contentType, localPath }) {
    this.target = target;
    this.partSize = target.partSize;
    this.contentType = contentType;
    this.localPath = localPath;
    this.file = fs.createWriteStream(localPath);
    this.fileError = null;
    // Disk full / volume gone: never crash the app; the live upload carries on without the local copy.
    this.file.on("error", (err) => {
      this.fileError = err;
      console.error("[uploader] local copy failed:", err.message);
    });
    this.pending = [];
    this.pendingBytes = 0;
    this.totalBytes = 0;
    this.nextPart = 1;
    this.nextStart = 0;
    this.parts = [];
    this.inflight = new Set();
    this.queue = [];
    this.queuedBytes = 0;
    this.live = true;
    this.liveError = null;
    this.finishing = false;
    // MP4: the first part (with the header) is uploaded last, once the real duration and the seek index can be
    // written into the file (see mp4-index.js). Everything after it still uploads live while recording.
    this.indexMp4 = contentType === "video/mp4";
    this.firstJob = null;
    this.indexed = null;
    this.ready = this.#init();
  }

  async #init() {
    for (let attempt = 1, delay = 1000; ; attempt++) {
      try {
        this.mpu = await this.target.create(this.contentType);
        return;
      } catch (err) {
        if (err.fatal || (this.finishing && attempt >= 3) || !this.live) return this.#goOffline(err);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, LIVE_RETRY_MAX_DELAY);
      }
    }
  }

  #goOffline(err) {
    if (!this.live) return;
    this.live = false;
    this.liveError = err;
    this.queue = [];
    this.queuedBytes = 0;
    console.warn(`[uploader] live upload disabled, will upload local file at the end: ${err.message}`);
  }

  push(buf) {
    if (!this.fileError) this.file.write(buf);
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

  #enqueue(body, { keep = false } = {}) {
    const job = { partNumber: this.nextPart++, start: this.nextStart, length: body.length, body };
    this.nextStart += body.length;
    if (job.partNumber === 1 && this.indexMp4 && !this.finishing) {
      this.firstJob = job; // held in memory until finish()
      return;
    }
    // Keep only a bounded amount in memory; the rest is read back from the local file later
    // (never a part whose bytes differ from the file, like the indexed last part).
    if (!keep && this.queuedBytes + body.length > MAX_QUEUED_BYTES && !this.fileError) job.body = null;
    else this.queuedBytes += body.length;
    this.queue.push(job);
    this.#pump();
  }

  /** A part that was dropped from memory, read back from the local file once it has been written. */
  async #readPart(job) {
    while (this.file.bytesWritten < job.start + job.length) {
      if (this.fileError) throw Object.assign(new Error("the local copy is unavailable"), { fatal: true });
      await new Promise((r) => setTimeout(r, 200));
    }
    const fd = await fs.promises.open(this.localPath, "r");
    try {
      const buf = Buffer.alloc(job.length);
      await fd.read(buf, 0, job.length, job.start);
      return buf;
    } finally {
      await fd.close();
    }
  }

  async #upload(job) {
    await this.ready;
    if (!this.live) return;
    const body = job.body ?? (await this.#readPart(job));
    for (let attempt = 1, delay = 1000; this.live; attempt++) {
      try {
        this.parts.push(await this.target.uploadPart(this.mpu, job.partNumber, body, this.contentType));
        return;
      } catch (err) {
        // While recording there's time: keep trying (the network may be back in a minute). Once the user
        // stopped, give up after a few tries and upload the local file instead.
        if (err.fatal || (this.finishing && attempt >= FINISH_ATTEMPTS)) throw err;
        console.warn(`[uploader] part ${job.partNumber} failed (attempt ${attempt}): ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, this.finishing ? 8000 : LIVE_RETRY_MAX_DELAY);
      }
    }
  }

  #pump() {
    while (this.live && this.inflight.size < MAX_PARALLEL && this.queue.length) {
      const job = this.queue.shift();
      const p = this.#upload(job)
        .catch((err) => this.#goOffline(err))
        .finally(() => {
          if (job.body) this.queuedBytes -= job.length;
          job.body = null;
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
    this.finishing = true;
    await new Promise((resolve) => {
      if (this.fileError || this.file.destroyed) return resolve();
      this.file.end(() => resolve());
    });
    await this.ready;
    const plan = this.#indexPlan();
    if (this.live) {
      let last = this.pendingBytes > 0 ? this.#take(this.pendingBytes) : Buffer.alloc(0);
      if (this.firstJob) {
        const job = this.firstJob;
        if (plan) job.body = Buffer.concat([plan.header, job.body.subarray(plan.headerEnd)]);
        job.length = job.body.length;
        this.queuedBytes += job.length;
        this.queue.unshift(job);
        if (plan) last = Buffer.concat([last, plan.tail]);
      } else if (plan) {
        last = Buffer.concat([plan.header, last.subarray(plan.headerEnd), plan.tail]); // the whole recording is one part
      }
      this.firstJob = null;
      if (last.length) this.#enqueue(last, { keep: Boolean(plan) });
      else this.#pump();
    }
    await this.#drain();
    // The local copy gets the same header and index (the parts above were read from it before this).
    const liveDone = this.live && this.parts.length && this.parts.length === this.nextPart - 1;
    if (plan) {
      try {
        mp4.applyPlan(this.localPath, plan);
        this.indexed = plan;
      } catch (err) {
        console.warn("[uploader] couldn't index the local copy:", err.message); // a fallback upload sends it as recorded
      }
      if (this.indexed || liveDone) this.totalBytes += plan.header.length - plan.headerEnd + plan.tail.length;
    }

    if (liveDone) {
      const parts = [...this.parts].sort((a, b) => a.partNumber - b.partNumber);
      return withRetry("complete multipart upload", () => this.target.complete(this.mpu, parts, this.contentType));
    }
    if (this.fileError) throw new Error(`The live upload didn't finish and the local copy couldn't be written (${this.fileError.message})`);
    return this.uploadLocalFile(onProgress);
  }

  /** Duration + seek index for an MP4 recording, when the local copy is complete. */
  #indexPlan() {
    if (!this.indexMp4 || this.fileError) return null;
    try {
      const plan = mp4.plan(this.localPath);
      // Only for a cleanly finished file: every byte of it was (or will be) uploaded as recorded.
      if (!plan || plan.usableSize !== this.totalBytes) return null;
      if (this.firstJob && plan.headerEnd > this.firstJob.length) return null;
      return plan;
    } catch (err) {
      console.warn("[uploader] no seek index:", err.message);
      return null;
    }
  }

  /** Flushes and closes the local copy (quitting mid-recording). */
  closeFile() {
    return new Promise((resolve) => {
      if (this.fileError || this.file.destroyed || this.file.writableEnded) return resolve();
      this.file.end(() => resolve());
    });
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
