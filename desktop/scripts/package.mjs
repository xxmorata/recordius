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

// 2. Launcher bundle with the app code as an extra resource.
const launcher = path.join(stage, "launcher");
cpSync(path.join(root, "launcher"), launcher, { recursive: true });
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
// Ad-hoc signature: no Apple Developer account needed. Users right-click → Open once.
execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit" });
console.log(`built ${bundle}`);

if (!flag("--no-install")) {
  const dest = path.join(homedir(), "Applications", "Recordius.app");
  rmSync(dest, { recursive: true, force: true });
  cpSync(bundle, dest, { recursive: true, verbatimSymlinks: true });
  execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-u", bundle]);
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

function walkSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? walkSize(p) * 1024 * 1024 : statSync(p).size;
  }
  return Math.round((total / 1024 / 1024) * 10) / 10;
}
