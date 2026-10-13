// Integrity of app code that lives outside the signed .app bundle (in-app updates).
//
// Every release's app folder carries manifest.json (SHA-256 of every file) and manifest.sig (an Ed25519
// signature of manifest.json made with the release key, kept as a GitHub secret). The updater refuses an
// update that doesn't verify, and the launcher — which sits inside the code-signed bundle and gets a copy
// of this file — checks it again on every start, so code dropped into ~/Library/Application Support can't
// run with Recordius' Screen Recording / Camera / Microphone permissions.
//
// Forks that publish their own releases: replace PUBLIC_KEY with yours (see docs/desktop.md).
// No dependencies: this file is also copied into the launcher.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmOFPyq5ily9Wy+r1t+YVrw/p/329PFYhVJ/qnZ7bKqw=
-----END PUBLIC KEY-----`;

const MANIFEST = "manifest.json";
const SIGNATURE = "manifest.sig";

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`unexpected symlink ${rel}`);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Writes manifest.json for a folder (build time). Returns its bytes. */
function writeManifest(dir, version) {
  const files = {};
  for (const rel of walk(dir).sort()) if (rel !== MANIFEST && rel !== SIGNATURE) files[rel] = sha256(path.join(dir, rel));
  const bytes = Buffer.from(JSON.stringify({ version, files }, null, 1));
  fs.writeFileSync(path.join(dir, MANIFEST), bytes);
  return bytes;
}

/** Signs a folder's manifest with a PEM private key (build time). */
function signManifest(dir, privateKeyPem) {
  const bytes = fs.readFileSync(path.join(dir, MANIFEST));
  fs.writeFileSync(path.join(dir, SIGNATURE), crypto.sign(null, bytes, crypto.createPrivateKey(privateKeyPem)).toString("base64"));
}

/**
 * Throws unless `dir` holds exactly the files its signed manifest lists, byte for byte.
 * @returns {string} the version recorded in the manifest
 */
function verifyAppDir(dir, publicKeyPem = PUBLIC_KEY) {
  const manifestPath = path.join(dir, MANIFEST);
  const sigPath = path.join(dir, SIGNATURE);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(sigPath)) throw new Error("the update isn't signed");
  const bytes = fs.readFileSync(manifestPath);
  const signature = Buffer.from(fs.readFileSync(sigPath, "utf8").trim(), "base64");
  if (!crypto.verify(null, bytes, crypto.createPublicKey(publicKeyPem), signature)) throw new Error("the update's signature is invalid");
  const manifest = JSON.parse(bytes.toString("utf8"));
  const listed = Object.keys(manifest.files ?? {});
  const present = walk(dir).filter((rel) => rel !== MANIFEST && rel !== SIGNATURE);
  if (present.length !== listed.length || present.some((rel) => !(rel in manifest.files))) throw new Error("the update contains files it shouldn't");
  for (const rel of listed) if (sha256(path.join(dir, rel)) !== manifest.files[rel]) throw new Error(`${rel} was modified`);
  return String(manifest.version ?? "");
}

module.exports = { verifyAppDir, writeManifest, signManifest, PUBLIC_KEY };
