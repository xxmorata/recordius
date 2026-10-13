const fs = require("node:fs");
const path = require("node:path");
const config = require("./config");

/**
 * Local bookkeeping for recordings on this Mac:
 * - pending-uploads.json: recordings whose upload failed. Survives restarts; retried automatically.
 * - uploaded.json: recordings confirmed uploaded. Only these local copies are ever cleaned up, so a file
 *   that might be the only copy of a video is never deleted.
 */
const PENDING_FILE = path.join(config.DIR, "pending-uploads.json");
const UPLOADED_FILE = path.join(config.DIR, "uploaded.json");
const DAY = 24 * 60 * 60 * 1000;
// "<stamp> <video id>.<ext>" as written by the recorder, e.g. "2026-10-13 09.41.07 3f…e1.mp4"
const RECORDING_NAME = /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2} ([a-f0-9]{32})\.(mp4|webm)$/;

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function write(file, value) {
  fs.mkdirSync(config.DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic: a crash mid-write never leaves a broken file
}

/** @typedef {{id: string, server: string, localPath: string, durationMs: number, title?: string, shareUrl: string, failedAt: number, error?: string}} Pending */

/** @returns {Pending[]} */
function pending() {
  const list = read(PENDING_FILE, []);
  return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && typeof p.localPath === "string") : [];
}

function addPending(entry) {
  write(PENDING_FILE, [...pending().filter((p) => p.id !== entry.id), entry]);
}

function updatePending(id, patch) {
  write(PENDING_FILE, pending().map((p) => (p.id === id ? { ...p, ...patch } : p)));
}

function removePending(id) {
  const list = pending();
  if (list.some((p) => p.id === id)) write(PENDING_FILE, list.filter((p) => p.id !== id));
}

function markUploaded(id, localPath) {
  const done = read(UPLOADED_FILE, {});
  done[id] = { localPath, at: Date.now() };
  write(UPLOADED_FILE, done);
}

/**
 * Deletes local copies older than the "keep local copies" setting — only files named like our
 * recordings, confirmed uploaded, not pending and not the recording in progress.
 * @returns {number} files deleted
 */
function cleanUpLocalCopies({ keepDays, activePath = null, now = Date.now() } = {}) {
  if (!keepDays || !Number.isFinite(keepDays)) return 0;
  const done = read(UPLOADED_FILE, {});
  const pendingIds = new Set(pending().map((p) => p.id));
  let names = [];
  try {
    names = fs.readdirSync(config.RECORDINGS_DIR);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    const m = RECORDING_NAME.exec(name);
    if (!m) continue;
    const id = m[1];
    const file = path.join(config.RECORDINGS_DIR, name);
    if (!done[id] || pendingIds.has(id) || file === activePath) continue;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || now - st.mtimeMs < keepDays * DAY) continue;
      fs.rmSync(file);
      deleted++;
    } catch {}
  }
  // Forget ledger entries whose file is gone (deleted here or by the user).
  let changed = false;
  for (const [id, info] of Object.entries(done)) {
    if (!info?.localPath || !fs.existsSync(info.localPath)) {
      delete done[id];
      changed = true;
    }
  }
  if (changed) write(UPLOADED_FILE, done);
  return deleted;
}

module.exports = { pending, addPending, updatePending, removePending, markUploaded, cleanUpLocalCopies, RECORDING_NAME };
