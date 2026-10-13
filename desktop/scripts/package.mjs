#!/usr/bin/env node
// Builds Recordius for macOS.
//
//   node scripts/package.mjs              build dist/Recordius.app and install it to ~/Applications
//   node scripts/package.mjs --release    also produce dist/release/: Recordius-<v>-mac.dmg,
//                                         recordius-app-<v>.tar.gz (in-app update payload) and SHA256SUMS.txt
//   --arch arm64|x64|universal            default: universal
//   --no-install                          don't copy to ~/Applications
//
// The .app contains only the launcher; the app code is placed in Contents/Resources/app and can be
// replaced by the in-app updater without changing the bundle's signature (keeps macOS permissions).
import { packager } from "@electron/packager";
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const arch = opt("--arch", "universal");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const electronVersion = JSON.parse(readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8")).version;
const dist = path.join(root, "dist");
const stage = path.join(dist, "stage");

rmSync(dist, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. App code: src, renderer, assets, package.json + production node_modules.
const appCode = path.join(stage, "app");
mkdirSync(appCode);
for (const item of ["src", "renderer", "assets"]) cpSync(path.join(root, item), path.join(appCode, item), { recursive: true });
// Only runtime dependencies, installed fresh (no symlinks: @electron/universal can't merge them).
writeFileSync(path.join(appCode, "package.json"), JSON.stringify({ name: pkg.name, productName: pkg.productName, version, private: true, dependencies: pkg.dependencies }, null, 2));
execFileSync("npm", ["install", "--omit=dev", "--no-package-lock", "--no-bin-links", "--no-audit", "--no-fund", "--loglevel=error", "--ignore-scripts"], { cwd: appCode, stdio: "inherit" });
rmSync(path.join(appCode, "node_modules", ".bin"), { recursive: true, force: true });
console.log(`app code staged (${walkSize(appCode)} MB)`);

// Signed manifest of the app code, so the updater and the launcher can tell a genuine release from
// files someone dropped into ~/Library/Application Support (see src/verify.js).
//   RECORDIUS_UPDATE_SIGNING_KEY  PEM private key (CI secret UPDATE_SIGNING_KEY)
//   or ~/.config/recordius/update-signing.pem
const { writeManifest, signManifest } = createRequire(import.meta.url)("../src/verify.js");
const signingKeyFile = path.join(homedir(), ".config", "recordius", "update-signing.pem");
const signingKey = process.env.RECORDIUS_UPDATE_SIGNING_KEY || (existsSync(signingKeyFile) ? readFileSync(signingKeyFile, "utf8") : null);
writeManifest(appCode, version);
if (signingKey) {
  signManifest(appCode, signingKey);
  console.log("app code signed with the update key");
} else {
  console.warn("no update signing key: this build works, but its tarball can't be installed as an in-app update");
}

// 2. Launcher bundle with the app code as an extra resource.
const launcher = path.join(stage, "launcher");
cpSync(path.join(root, "launcher"), launcher, { recursive: true });
cpSync(path.join(root, "src", "verify.js"), path.join(launcher, "verify.js")); // the launcher checks updates with it
writeFileSync(path.join(launcher, "package.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(launcher, "package.json"), "utf8")), version }, null, 2));

const [appPath] = await packager({
  dir: launcher,
  out: path.join(dist, "pack"),
  overwrite: true,
  platform: "darwin",
  arch,
  electronVersion,
  name: "Recordius",
  executableName: "Recordius",
  appBundleId: "com.recordius.desktop",
  appCategoryType: "public.app-category.productivity",
  appCopyright: "MIT License",
  icon: path.join(root, "assets", "icon.icns"),
  asar: true,
  extraResource: [appCode],
  protocols: [{ name: "Recordius", schemes: ["recordius"] }],
  extendInfo: {
    NSCameraUsageDescription: "Recordius shows your camera bubble and records it.",
    NSMicrophoneUsageDescription: "Recordius records your voice together with your screen.",
    NSAudioCaptureUsageDescription: "Recordius can record your Mac's system audio.",
    LSMinimumSystemVersion: "13.0",
  },
});
const bundle = path.join(appPath, "Recordius.app");
// Electron fuses: no "run as plain Node", no NODE_OPTIONS and no --inspect — each of those would let any
// local process run its own code with Recordius' macOS permissions.
await flipFuses(bundle, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
});
// Signing. macOS ties privacy permissions (Screen Recording, Camera, Mic) to the app's code-signing
// requirement. With an ad-hoc signature that requirement is the hash of the build, so every build is
// a "new app" that has to be allowed again. A certificate — even a self-signed one — gives a stable
// requirement ("identifier … and certificate root = …"), so permissions survive every update.
//   RECORDIUS_SIGN_IDENTITY   name of the certificate (default: "Recordius Code Signing")
//   RECORDIUS_SIGN_KEYCHAIN   keychain that holds it (default: ~/Library/Keychains/recordius-signing.keychain-db)
// Without a usable certificate the build falls back to an ad-hoc signature.
const identity = process.env.RECORDIUS_SIGN_IDENTITY ?? "Recordius Code Signing";
const keychain = process.env.RECORDIUS_SIGN_KEYCHAIN ?? path.join(homedir(), "Library", "Keychains", "recordius-signing.keychain-db");
const signArgs = ["--force", "--deep", "--timestamp=none"];
let signedWith = "ad-hoc";
if (existsSync(keychain)) {
  try {
    execFileSync("codesign", [...signArgs, "--sign", identity, "--keychain", keychain, bundle], { stdio: "pipe" });
    signedWith = identity;
  } catch (err) {
    console.warn(`certificate signing failed (${String(err.stderr || err.message).trim()}); using ad-hoc`);
  }
}
if (signedWith === "ad-hoc") execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit" });
const requirement = execFileSync("codesign", ["-d", "-r-", bundle], { stdio: "pipe", encoding: "utf8" }).split("\n").find((l) => l.startsWith("designated"));
console.log(`built ${bundle}\nsigned with: ${signedWith}\n${requirement}`);

if (!flag("--no-install")) {
  const dest = path.join(homedir(), "Applications", "Recordius.app");
  try {
    execFileSync("pkill", ["-f", "Recordius.app/Contents/MacOS/Recordius"], { stdio: "ignore" });
  } catch {}
  rmSync(dest, { recursive: true, force: true });
  cpSync(bundle, dest, { recursive: true, verbatimSymlinks: true });
  console.log(`installed ${dest}`);
}

if (flag("--release")) {
  const release = path.join(dist, "release");
  mkdirSync(release);
  // in-app update payload
  const tarball = path.join(release, `recordius-app-${version}.tar.gz`);
  execFileSync("/usr/bin/tar", ["-czf", tarball, "-C", appCode, "."]);
  // DMG with an Applications shortcut
  const dmgRoot = path.join(stage, "dmg");
  mkdirSync(dmgRoot);
  cpSync(bundle, path.join(dmgRoot, "Recordius.app"), { recursive: true, verbatimSymlinks: true });
  execFileSync("ln", ["-s", "/Applications", path.join(dmgRoot, "Applications")]);
  const dmg = path.join(release, `Recordius-${version}-mac.dmg`);
  execFileSync("hdiutil", ["create", "-volname", "Recordius", "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", "-quiet", dmg]);
  // checksums
  const sums = readdirSync(release)
    .filter((f) => !f.startsWith("SHA256SUMS"))
    .map((f) => `${createHash("sha256").update(readFileSync(path.join(release, f))).digest("hex")}  ${f}`)
    .join("\n");
  writeFileSync(path.join(release, "SHA256SUMS.txt"), sums + "\n");
  console.log(`release assets in ${release}:\n${sums}`);
}

// Don't leave extra "Recordius" apps registered with macOS (they show up as duplicates in Spotlight
// and in Privacy settings): unregister every bundle that still sits in dist/.
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
for (const b of findBundles(dist)) {
  try {
    execFileSync(lsregister, ["-u", b], { stdio: "ignore" });
  } catch {}
}
rmSync(stage, { recursive: true, force: true });

function findBundles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith(".app")) out.push(p);
    else out.push(...findBundles(p));
  }
  return out;
}

function walkSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? walkSize(p) * 1024 * 1024 : statSync(p).size;
  }
  return Math.round((total / 1024 / 1024) * 10) / 10;
}
