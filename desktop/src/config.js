const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const DIR = app.getPath("userData"); // ~/Library/Application Support/Recordius
const CONFIG_FILE = path.join(DIR, "config.json");
const TOKEN_FILE = path.join(DIR, "device-token");
// Test runs (RECORDIUS_USER_DATA) keep their recordings inside their own scratch profile, never in ~/Movies.
const RECORDINGS_DIR = process.env.RECORDIUS_USER_DATA ? path.join(process.env.RECORDIUS_USER_DATA, "Recordings") : path.join(os.homedir(), "Movies", "Recordius");

const DEFAULTS = {
  server: null, // e.g. https://recordius.example.com
  account: null, // { name, email, workspace } cached from /api/me
  // recorder choices
  source: "screen", // "screen" | "window" | "camera"
  sourceId: null,
  cameraId: null, // null = default camera, "none" = off
  micId: null, // null = default mic, "none" = off
  systemAudio: false,
  mirrorCamera: true,
  countdown: true,
  quality: "1080",
  cameraSize: "m",
  keepLocalDays: 30, // local copies of uploaded recordings: 7, 30 or 0 (= keep forever)
  loginItemConfigured: false,
  updateRepo: "xxmorata/recordius",
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Kept in memory: only this process writes these files, and reading them on every API call and timer
// tick is wasted work on the main thread.
let cached = null;
let cachedToken; // undefined = not read yet

function load() {
  cached ??= { ...DEFAULTS, ...readJson(CONFIG_FILE) };
  return { ...cached };
}

function save(patch) {
  const next = { ...load(), ...patch };
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cached = next;
  return { ...next };
}

/**
 * The device token. Stored as a file readable only by this user (like the gh / vercel / aws CLIs do).
 * Electron's safeStorage would be nicer, but for an app without an Apple Developer signature it makes
 * macOS ask for the login password on first use — a dead end for people installing the app.
 */
function token() {
  if (cachedToken !== undefined) return cachedToken;
  try {
    cachedToken = fs.readFileSync(TOKEN_FILE, "utf8").trim() || null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

function saveToken(value) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, value, { mode: 0o600 });
  cachedToken = value;
}

function clearToken() {
  fs.rmSync(TOKEN_FILE, { force: true });
  cachedToken = null;
}

function isConnected() {
  const c = load();
  return Boolean(c.server && token());
}

module.exports = { DIR, RECORDINGS_DIR, load, save, token, saveToken, clearToken, isConnected };
