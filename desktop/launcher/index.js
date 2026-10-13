// Recordius launcher — the only code that lives inside the signed .app bundle.
//
// The real app (src/, renderer/, node_modules) ships in Contents/Resources/app and can be replaced
// by the in-app updater, which installs newer versions under ~/Library/Application Support/Recordius/app/.
// Because the bundle itself never changes, macOS keeps the Screen Recording / Camera / Microphone
// permissions across updates (they are tied to the app's code signature).
const fs = require("node:fs");
const path = require("node:path");
const { app, dialog } = require("electron");
// verify.js is copied here from src/ at build time (scripts/package.mjs); in a source checkout it's in ../src.
const { verifyAppDir } = fs.existsSync(path.join(__dirname, "verify.js")) ? require("./verify.js") : require("../src/verify.js");

function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return null;
  }
}

function newer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// Tests point both the launcher and the app at a scratch folder. Whatever the folder, updated code only
// runs when its signature checks out (pickAppDir below).
if (process.env.RECORDIUS_USER_DATA) app.setPath("userData", process.env.RECORDIUS_USER_DATA);

function pickAppDir() {
  if (!app.isPackaged) return path.join(__dirname, "..");
  const embedded = path.join(process.resourcesPath, "app");
  const updatesRoot = path.join(app.getPath("userData"), "app");
  try {
    const current = JSON.parse(fs.readFileSync(path.join(updatesRoot, "current.json"), "utf8"));
    if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(current.dir))) return embedded;
    const dir = path.join(updatesRoot, current.dir);
    const v = readVersion(dir);
    if (v && newer(v, readVersion(embedded) || "0.0.0") && fs.existsSync(path.join(dir, "src", "main.js"))) {
      // Only code signed with the release key runs inside this (code-signed, permission-holding) app.
      try {
        if (verifyAppDir(dir) === v) return dir;
        console.error(`[recordius] update ${v} doesn't match its manifest; using the built-in version`);
      } catch (err) {
        console.error(`[recordius] ignoring update ${v}: ${err.message}`);
      }
    }
  } catch {}
  return embedded;
}

const appDir = pickAppDir();
process.env.RECORDIUS_APP_DIR = appDir;
process.env.RECORDIUS_EMBEDDED_VERSION = app.isPackaged ? readVersion(path.join(process.resourcesPath, "app")) || "0.0.0" : "dev";

try {
  require(path.join(appDir, "src", "main.js"));
} catch (err) {
  app.whenReady().then(() => {
    dialog.showErrorBox("Recordius couldn't start", `${err.stack || err}\n\nApp code: ${appDir}`);
    app.quit();
  });
}
