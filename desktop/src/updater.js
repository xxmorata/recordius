// In-app updates that keep macOS permissions: the signed launcher bundle never changes; new app
// code is downloaded to ~/Library/Application Support/Recordius/app/<version>/ and loaded by it.
const http = require("./http");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { app } = require("electron");
const config = require("./config");
const { verifyAppDir } = require("./verify");

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.RECORDIUS_APP_DIR ?? path.join(__dirname, ".."), "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

function newer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/** Looks up the latest GitHub release. `releasesUrl` is overridable for tests. */
async function check(releasesUrl = process.env.RECORDIUS_UPDATE_URL || `https://api.github.com/repos/${config.load().updateRepo}/releases/latest`) {
  const res = await http.fetch(releasesUrl, { headers: { accept: "application/vnd.github+json", "user-agent": "Recordius-desktop" } });
  if (!res.ok) throw new Error(`Update check failed (${res.status})`);
  const release = await res.json();
  const version = String(release.tag_name ?? "").replace(/^v/, "");
  if (!SEMVER.test(version)) throw new Error("The latest release has an unexpected version number");
  const tarball = release.assets?.find((a) => /^recordius-app-.*\.tar\.gz$/.test(a.name));
  const sums = release.assets?.find((a) => a.name === "SHA256SUMS.txt");
  return {
    current: currentVersion(),
    latest: version,
    available: Boolean(tarball && sums && newer(version, currentVersion())),
    tarballUrl: tarball?.browser_download_url ?? null,
    tarballName: tarball?.name ?? null,
    sumsUrl: sums?.browser_download_url ?? null,
    notes: release.body ?? "",
    pageUrl: release.html_url ?? null,
  };
}

/** Downloads, verifies and installs an update; resolves when a relaunch will load it. */
async function install(info, onProgress = () => {}) {
  if (!app.isPackaged) throw new Error("Updates only apply to the installed app");
  if (!info.tarballUrl || !info.sumsUrl) throw new Error("This release has no desktop update");
  if (!SEMVER.test(String(info.latest))) throw new Error("Unexpected version number");
  const root = path.join(app.getPath("userData"), "app");
  const tmp = path.join(root, `download-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const sumsText = await (await http.fetch(info.sumsUrl)).text();
    const expected = sumsText
      .split("\n")
      .map((l) => l.trim().split(/\s+\*?/))
      .find(([, name]) => name === info.tarballName)?.[0];
    if (!expected) throw new Error("Checksum for the update is missing");

    const res = await http.fetch(info.tarballUrl);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get("content-length")) || 0;
    const file = path.join(tmp, info.tarballName);
    const hash = createHash("sha256");
    let received = 0;
    const out = fs.createWriteStream(file);
    for await (const chunk of res.body) {
      hash.update(chunk);
      out.write(chunk);
      received += chunk.length;
      if (total) onProgress(received / total);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (hash.digest("hex") !== expected) throw new Error("The update's checksum doesn't match");

    const dest = path.join(root, info.latest);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    execFileSync("/usr/bin/tar", ["-xzf", file, "-C", dest]);
    if (!fs.existsSync(path.join(dest, "src", "main.js"))) throw new Error("The update archive is incomplete");
    // Signed by the release key: a tampered release (or GitHub asset) is refused. The launcher checks again on start.
    try {
      if (verifyAppDir(dest) !== info.latest) throw new Error("the update is for a different version");
    } catch (err) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw new Error(`Refused the update: ${err.message}`);
    }
    fs.writeFileSync(path.join(root, "current.json"), JSON.stringify({ dir: info.latest, version: info.latest, installedAt: Date.now() }));
    // keep only the newest two versions around
    for (const entry of fs.readdirSync(root)) {
      if (/^\d+\.\d+\.\d+$/.test(entry) && entry !== info.latest && newer(info.latest, entry) && entry !== currentVersion()) {
        fs.rmSync(path.join(root, entry), { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { check, install, currentVersion };
