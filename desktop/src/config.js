const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const DIR = app.getPath("userData"); // ~/Library/Application Support/Recordius
const CONFIG_FILE = path.join(DIR, "config.json");
const TOKEN_FILE = path.join(DIR, "device-token");
const RECORDINGS_DIR = path.join(os.homedir(), "Movies", "Recordius");

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

function load() {
  return { ...DEFAULTS, ...readJson(CONFIG_FILE) };
}

function save(patch) {
  const next = { ...load(), ...patch };
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/**
 * The device token. Stored as a file readable only by this user (like the gh / vercel / aws CLIs do).
 * Electron's safeStorage would be nicer, but for an app without an Apple Developer signature it makes
 * macOS ask for the login password on first use — a dead end for people installing the app.
 */
function token() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function saveToken(value) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, value, { mode: 0o600 });
}

function clearToken() {
  fs.rmSync(TOKEN_FILE, { force: true });
}

function isConnected() {
  const c = load();
  return Boolean(c.server && token());
}

module.exports = { DIR, RECORDINGS_DIR, load, save, token, saveToken, clearToken, isConnected };
