const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
// Tests point this at a scratch directory so the real configuration is never touched.
if (process.env.RECORDIUS_USER_DATA) require("electron").app.setPath("userData", process.env.RECORDIUS_USER_DATA);
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  desktopCapturer,
  session,
  screen,
  globalShortcut,
  clipboard,
  shell,
  Notification,
  systemPreferences,
  nativeImage,
  dialog,
} = require("electron");
const config = require("./config");
const api = require("./api");
const updater = require("./updater");
const { LiveUploader, uploadThumbnail } = require("./uploader");

const APP_DIR = path.join(__dirname, "..");
const RENDERER = path.join(APP_DIR, "renderer");
const ASSETS = path.join(APP_DIR, "assets");
const VERSION = updater.currentVersion();
const SHORTCUT_TOGGLE = "CommandOrControl+Shift+R";
const SHORTCUT_PAUSE = "CommandOrControl+Shift+P";
const COUNTDOWN_MS = 3000;
const PANEL_WIDTH = 380;
const PANEL_MARGIN = 28; // transparent space around the panel for its CSS shadow
const PANEL_WINDOW = PANEL_WIDTH + PANEL_MARGIN * 2;
const BUBBLE_MARGIN = 24;
const E2E = Boolean(process.env.RECORDIUS_E2E);
const log = (...args) => process.env.RECORDIUS_DEBUG && console.log("[recordius]", ...args);

/** @type {"idle"|"preparing"|"recording"|"paused"|"stopping"} */
let state = "idle";
let rec = null; // active recording session
const failedUploads = []; // recordings kept locally whose upload failed
const win = { panel: null, camera: null, controls: null, countdown: null, recorder: null };
let tray = null;
let trayTimer = null;
let lastSources = [];
let pendingSourceId = null;
let pendingSystemAudio = false;
let pendingDeepLinks = [];
// macOS emits 'hide'/'show' for occlusion changes too, and isVisible() lags behind hide() for a moment.
// The preview guard therefore combines isVisible() with timestamps of the last hide/show events.
let panelHideStamp = 0;
let panelShowStamp = 0;

// ───────────────────────────── windows ─────────────────────────────

function createWindow(name, opts, file, query) {
  const w = new BrowserWindow({
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    title: `Recordius ${name}`,
    ...opts,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  w.loadFile(path.join(RENDERER, file), { query });
  w.on("closed", () => {
    if (win[name] === w) win[name] = null;
  });
  win[name] = w;
  return w;
}

function activeDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function displayForSource(sourceId) {
  if (sourceId?.startsWith("screen:")) {
    const src = lastSources.find((s) => s.id === sourceId);
    const match = src && screen.getAllDisplays().find((d) => String(d.id) === String(src.display_id));
    if (match) return match;
  }
  return activeDisplay();
}

/** The panel window is created once at startup (hidden) so opening it later is instant. */
function ensurePanelWindow() {
  if (win.panel && !win.panel.isDestroyed()) return win.panel;
  // No native shadow: for a transparent window macOS draws it for the whole rectangle, which shows up
  // as a faint box around the rounded panel. The panel draws its own shadow in CSS instead.
  const w = createWindow("panel", { width: PANEL_WINDOW, height: 560, transparent: true, hasShadow: false, alwaysOnTop: false }, "panel.html");
  placePanel(w);
  w.on("close", (e) => {
    // ⌘W / window close keeps the (hidden) window around so the next open stays instant.
    e.preventDefault();
    hidePanel();
  });
  // The preview bubble belongs to the panel: it goes away when the panel is hidden (⌘H, close) or
  // simply loses focus (another app in front), and comes back when the panel is focused again.
  w.on("show", () => {
    panelShowStamp = Date.now();
    w.webContents.send("panel:visibility", true);
  });
  w.on("focus", () => {
    panelShowStamp = Date.now();
    w.webContents.send("panel:visibility", true);
  });
  w.on("hide", () => {
    panelHideStamp = Date.now();
    w.webContents.send("panel:visibility", false);
    if (state === "idle") hideCamera();
  });
  w.on("blur", () => {
    if (state === "idle" && !E2E) hideCamera();
  });
  return w;
}

function placePanel(w) {
  const d = activeDisplay().workArea;
  w.setPosition(Math.round(d.x + d.width / 2 - PANEL_WINDOW / 2), Math.round(d.y + Math.max(20, d.height / 2 - 300)));
}

let panelPlaced = false;
function showPanel(view) {
  if (state !== "idle") return;
  const w = ensurePanelWindow();
  const reveal = () => {
    if (!w.isVisible()) {
      if (!panelPlaced) placePanel(w); // first open: centre on the display the user is on
      panelPlaced = true;
      w.show();
    }
    w.focus();
    if (view) w.webContents.send("panel:navigate", view);
  };
  if (w.webContents.isLoading()) w.once("ready-to-show", reveal);
  else reveal();
}

function hidePanel() {
  win.panel?.hide();
  if (state === "idle") hideCamera();
}

const CAMERA_SIZES = { s: 160, m: 230, l: 340 };
let cameraVisible = false;
let cameraReadyWaiters = [];

function cameraPlacement(display, size) {
  return { x: display.workArea.x + 32 - BUBBLE_MARGIN, y: display.workArea.y + display.workArea.height - size - 32 - BUBBLE_MARGIN };
}

/** Shows the camera bubble; created once, then hidden/shown so switching settings never restarts the camera. */
function showCamera(cameraId, display) {
  const size = (CAMERA_SIZES[config.load().cameraSize] ?? CAMERA_SIZES.m) + BUBBLE_MARGIN * 2;
  const target = display ?? activeDisplay();
  let w = win.camera;
  if (!w) {
    w = createWindow("camera", { width: size, height: size, ...cameraPlacement(target, size), transparent: true, hasShadow: false, alwaysOnTop: true, focusable: false }, "camera.html");
    // Intentionally *not* content-protected: like Loom, the bubble is recorded as part of the screen.
    w.setAlwaysOnTop(true, "screen-saver");
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else if (display) {
    const current = screen.getDisplayMatching(w.getBounds());
    if (current.id !== display.id) w.setPosition(...Object.values(cameraPlacement(display, w.getSize()[1])));
  }
  cameraVisible = true;
  const payload = { deviceId: cameraId || null, mirror: config.load().mirrorCamera !== false };
  const send = () => w.webContents.send("camera:show", payload);
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send);
  else send();
  return new Promise((resolve) => {
    cameraReadyWaiters.push(resolve);
    setTimeout(resolve, 4000);
  });
}

ipcMain.on("camera:ready", () => {
  if (cameraVisible && win.camera && !win.camera.isVisible()) win.camera.showInactive();
  cameraReadyWaiters.forEach((r) => r());
  cameraReadyWaiters = [];
});

function hideCamera() {
  cameraVisible = false;
  if (!win.camera) return;
  win.camera.hide();
  win.camera.webContents.send("camera:hide");
}

function showControls(display) {
  const w = createWindow(
    "controls",
    { width: 64, height: 320, x: display.workArea.x + 16, y: Math.round(display.workArea.y + display.workArea.height / 2 - 160), transparent: true, hasShadow: false, alwaysOnTop: true },
    "controls.html",
  );
  // Keep the control bar out of the recording (Loom excludes its windows via ScreenCaptureKit).
  w.setContentProtection(true);
  w.setAlwaysOnTop(true, "screen-saver");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.once("ready-to-show", () => w.showInactive());
}

function showCountdown(display) {
  return new Promise((resolve) => {
    const w = createWindow("countdown", { ...display.bounds, transparent: true, hasShadow: false, alwaysOnTop: true, focusable: false }, "countdown.html", { ms: String(COUNTDOWN_MS) });
    w.setContentProtection(true);
    w.setIgnoreMouseEvents(true);
    w.setAlwaysOnTop(true, "screen-saver");
    w.once("ready-to-show", () => w.showInactive());
    setTimeout(() => {
      if (!w.isDestroyed()) w.close();
      resolve();
    }, COUNTDOWN_MS);
  });
}

function ensureRecorderWindow() {
  if (win.recorder) return win.recorder;
  return createWindow("recorder", { width: 400, height: 300 }, "recorder.html");
}

// ───────────────────────────── tray & dock ─────────────────────────────

function trayIcon() {
  const img = nativeImage.createFromPath(path.join(ASSETS, "trayTemplate.png"));
  img.setTemplateImage(true);
  return img;
}

function elapsedMs() {
  if (!rec?.startedAt) return 0;
  const pausedNow = rec.pausedAt ? Date.now() - rec.pausedAt : 0;
  return Date.now() - rec.startedAt - rec.pausedTotal - pausedNow;
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function refreshTray() {
  if (!tray) return;
  const recording = state === "recording" || state === "paused";
  tray.setTitle(recording ? ` ${state === "paused" ? "❚❚" : "●"} ${fmt(elapsedMs())}` : "");
  const template = [
    recording
      ? { label: "Stop recording", accelerator: SHORTCUT_TOGGLE, click: () => stopRecording() }
      : { label: "New recording…", accelerator: SHORTCUT_TOGGLE, enabled: state === "idle", click: () => showPanel() },
    ...(recording
      ? [
          { label: state === "paused" ? "Resume" : "Pause", accelerator: SHORTCUT_PAUSE, click: () => togglePause() },
          { label: "Delete recording", click: () => cancelRecording() },
        ]
      : []),
    { type: "separator" },
    { label: "Open my library", enabled: config.isConnected(), click: () => openLibrary() },
    { label: "Settings…", click: () => showPanel("settings") },
    { label: "Show recordings folder", click: () => shell.openPath(config.RECORDINGS_DIR) },
    ...(failedUploads.length ? [{ label: `Retry failed uploads (${failedUploads.length})`, click: () => retryFailedUploads() }] : []),
    { type: "separator" },
    { label: "Quit Recordius", role: "quit" },
  ];
  tray.setContextMenu(null);
  tray.removeAllListeners("click");
  tray.removeAllListeners("right-click");
  const menu = Menu.buildFromTemplate(template);
  tray.on("click", () => (state === "idle" ? showPanel() : tray.popUpContextMenu(menu)));
  tray.on("right-click", () => tray.popUpContextMenu(menu));
}

function setState(next) {
  state = next;
  refreshTray();
  win.controls?.webContents.send("controls:state", { state, elapsedMs: elapsedMs() });
  win.panel?.webContents.send("panel:state", state);
  clearInterval(trayTimer);
  if (state === "recording" || state === "paused") {
    trayTimer = setInterval(() => {
      refreshTray();
      win.controls?.webContents.send("controls:state", { state, elapsedMs: elapsedMs() });
    }, 500);
  }
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  if (onClick) n.on("click", onClick);
  n.show();
}

// ───────────────────────────── account / deep links ─────────────────────────────

function normalizeServer(input) {
  let url = String(input ?? "").trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Verifies a server + token pair, stores it, and tells the panel. */
async function connect(server, token) {
  const base = normalizeServer(server);
  if (!base || !token) throw new Error("That connection code isn't valid");
  const me = await api.me({ server: base, token });
  config.saveToken(token);
  config.save({ server: me.serverUrl ? normalizeServer(me.serverUrl) ?? base : base, account: { name: me.user.name, email: me.user.email, workspace: me.workspace.name, avatarUrl: me.user.avatarUrl } });
  win.panel?.webContents.send("account:changed", accountInfo());
  refreshTray();
  notify("Recordius is connected", `${me.user.name} · ${me.workspace.name}. Press ⌘⇧R to record.`);
  return me;
}

function accountInfo() {
  const c = config.load();
  return { connected: config.isConnected(), server: c.server, account: c.account };
}

async function refreshAccount() {
  if (!config.isConnected()) return;
  try {
    const me = await api.me();
    config.save({ account: { name: me.user.name, email: me.user.email, workspace: me.workspace.name, avatarUrl: me.user.avatarUrl } });
  } catch (err) {
    if (err.status === 401) {
      // Token revoked from the web app.
      config.clearToken();
      win.panel?.webContents.send("account:changed", accountInfo());
      notify("Recordius was disconnected", "This Mac was removed from your account. Connect it again from the web app.");
    }
  }
}

function signOut() {
  config.clearToken();
  config.save({ account: null });
  win.panel?.webContents.send("account:changed", accountInfo());
  refreshTray();
}

function handleDeepLink(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== "recordius:") return;
  const action = url.hostname || url.pathname.replace(/^\/+/, "");
  log("deep link", action);
  if (action === "connect") {
    showPanel();
    connect(url.searchParams.get("server"), url.searchParams.get("token")).catch((err) => {
      dialog.showErrorBox("Couldn't connect Recordius", err.message);
    });
  } else if (action === "record") {
    if (state === "idle") startRecording();
  } else if (action === "stop") {
    stopRecording();
  } else {
    showPanel();
  }
}

async function openLibrary() {
  const server = api.serverUrl();
  if (server) shell.openExternal(`${server}/library`);
}

// ───────────────────────────── recording lifecycle ─────────────────────────────

function recorderRequest(channel, payload, reply) {
  return new Promise((resolve, reject) => {
    const ok = (_e, data) => {
      cleanup();
      resolve(data);
    };
    const fail = (_e, message) => {
      cleanup();
      reject(new Error(message));
    };
    const cleanup = () => {
      ipcMain.removeListener(reply, ok);
      ipcMain.removeListener("rec:error", fail);
    };
    ipcMain.once(reply, ok);
    ipcMain.once("rec:error", fail);
    win.recorder.webContents.send(channel, payload);
  });
}

/** Translates the panel's choices into what the recorder needs. */
function recordingPlan(settings) {
  const cameraOn = settings.cameraId !== "none";
  const mode = settings.source === "camera" ? "cam" : cameraOn ? "screen-cam" : "screen";
  return { ...settings, mode, cameraId: cameraOn ? settings.cameraId : null };
}

async function startRecording(opts) {
  if (state !== "idle") return;
  if (!config.isConnected()) return showPanel();
  // Remember the user's choices for the next shortcut start (but never the test harness's).
  const settings = E2E ? { ...config.load(), ...opts } : config.save(opts ?? {});
  const plan = recordingPlan(settings);
  if (plan.mode !== "cam" && !plan.sourceId) return showPanel();
  win.panel?.hide();
  setState("preparing");

  if (plan.mode !== "cam" && !lastSources.some((s) => s.id === plan.sourceId)) {
    lastSources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
    if (!lastSources.some((s) => s.id === plan.sourceId)) {
      setState("idle");
      return showPanel(); // the remembered window is gone; let the user pick again
    }
  }

  const display = plan.mode === "cam" ? activeDisplay() : displayForSource(plan.sourceId);
  const cameraReady = plan.mode === "screen" ? Promise.resolve() : showCamera(plan.cameraId, display);
  if (plan.mode === "screen") hideCamera();

  try {
    const recorder = ensureRecorderWindow();
    if (recorder.webContents.isLoading()) await new Promise((r) => recorder.webContents.once("did-finish-load", r));
    pendingSystemAudio = plan.systemAudio;
    pendingSourceId = plan.sourceId;

    // Like Loom's prepareForStart: acquire capture streams and open the upload session during the countdown.
    const prepared = await recorderRequest("rec:prepare", plan, "rec:prepared");
    const countdown = plan.countdown === false ? Promise.resolve() : showCountdown(display);
    const video = await api.createVideo(defaultTitle(), prepared.mimeType);
    log("session created", video.id);
    fs.mkdirSync(config.RECORDINGS_DIR, { recursive: true });
    const ext = video.upload.videoPathname.split(".").pop();
    const localPath = path.join(config.RECORDINGS_DIR, `${stamp()} ${video.id}.${ext}`);
    rec = {
      video,
      plan,
      display,
      localPath,
      mimeType: prepared.mimeType,
      uploader: new LiveUploader({
        pathname: video.upload.videoPathname,
        token: video.upload.videoToken,
        access: video.upload.access ?? "private",
        contentType: prepared.mimeType.split(";")[0],
        localPath,
      }),
      startedAt: 0,
      pausedAt: 0,
      pausedTotal: 0,
    };
    if (prepared.warning) notify("Recordius", prepared.warning);
    await countdown;
    await cameraReady; // never start recording before the bubble shows a picture
    if (state !== "preparing") return; // cancelled during countdown
    await recorderRequest("rec:start", null, "rec:started");
    rec.startedAt = Date.now();
    showControls(display);
    setState("recording");
  } catch (err) {
    console.error("[main] start failed", err);
    if (win.countdown && !win.countdown.isDestroyed()) win.countdown.close();
    hideCamera();
    win.recorder?.webContents.send("rec:discard");
    if (rec) {
      rec.uploader.abort();
      api.deleteVideo(rec.video.id).catch(() => {});
      rec = null;
    }
    setState("idle");
    const text = err.status === 401 ? "This Mac is no longer connected. Open Recordius and connect it again." : err.message;
    notify("Couldn't start recording", text);
    showPanel();
  }
}

async function stopRecording() {
  if (state !== "recording" && state !== "paused") return;
  const sessionRec = rec;
  const durationMs = elapsedMs();
  setState("stopping");
  win.controls?.close();
  hideCamera();
  await recorderRequest("rec:stop", null, "rec:stopped").catch((err) => console.error("[main] stop", err));
  rec = null;
  setState("idle");

  // Exactly Loom's openSharePageAndCopyUrl: the link is ready the moment you stop.
  if (!E2E) {
    clipboard.writeText(sessionRec.video.shareUrl);
    shell.openExternal(sessionRec.video.shareUrl);
  }
  notify("Link copied to clipboard", "Finishing the upload — your video will play in a few seconds.");
  await finishUpload(sessionRec, durationMs);
}

async function finishUpload(sessionRec, durationMs) {
  try {
    await sessionRec.uploader.finish();
    await api.completeVideo(sessionRec.video.id, durationMs, sessionRec.uploader.totalBytes);
    notify("Your video is ready", sessionRec.video.title ?? sessionRec.video.shareUrl, () => shell.openExternal(sessionRec.video.shareUrl));
    const i = failedUploads.indexOf(sessionRec);
    if (i >= 0) failedUploads.splice(i, 1);
  } catch (err) {
    console.error("[main] upload failed", err);
    sessionRec.durationMs = durationMs;
    if (!failedUploads.includes(sessionRec)) failedUploads.push(sessionRec);
    notify("Upload failed", `Saved locally. Use “Retry failed uploads” in the menu bar. (${err.message})`);
  }
  refreshTray();
}

async function retryFailedUploads() {
  for (const sessionRec of [...failedUploads]) {
    try {
      await sessionRec.uploader.uploadLocalFile();
      await api.completeVideo(sessionRec.video.id, sessionRec.durationMs, fs.statSync(sessionRec.localPath).size);
      failedUploads.splice(failedUploads.indexOf(sessionRec), 1);
      notify("Upload finished", sessionRec.video.shareUrl, () => shell.openExternal(sessionRec.video.shareUrl));
    } catch (err) {
      notify("Retry failed", err.message);
    }
  }
  refreshTray();
}

async function cancelRecording({ restart = false } = {}) {
  if (!["preparing", "recording", "paused"].includes(state)) return;
  const sessionRec = rec;
  const settings = sessionRec?.plan ?? config.load();
  rec = null;
  win.controls?.close();
  if (win.countdown && !win.countdown.isDestroyed()) win.countdown.close();
  if (!restart) hideCamera();
  win.recorder?.webContents.send("rec:discard");
  setState("idle");
  if (sessionRec) {
    sessionRec.uploader.abort();
    fs.rm(sessionRec.localPath, { force: true }, () => {});
    api.deleteVideo(sessionRec.video.id).catch(() => {});
  }
  if (restart) setTimeout(() => startRecording(settings), 300);
}

function togglePause() {
  if (state === "recording") {
    rec.pausedAt = Date.now();
    win.recorder.webContents.send("rec:pause");
    setState("paused");
  } else if (state === "paused") {
    rec.pausedTotal += Date.now() - rec.pausedAt;
    rec.pausedAt = 0;
    win.recorder.webContents.send("rec:resume");
    setState("recording");
  }
}

function toggleCameraBubble() {
  if (!rec || rec.plan.mode !== "screen-cam") return;
  if (win.camera?.isVisible()) hideCamera();
  else showCamera(rec.plan.cameraId, rec.display);
}

function defaultTitle() {
  const d = new Date();
  return `Recording ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, ".");
}

// ───────────────────────────── IPC: panel ─────────────────────────────

ipcMain.handle("panel:init", async () => ({
  ...accountInfo(),
  settings: config.load(),
  media: {
    screen: systemPreferences.getMediaAccessStatus("screen"),
    camera: systemPreferences.getMediaAccessStatus("camera"),
    microphone: systemPreferences.getMediaAccessStatus("microphone"),
  },
  version: VERSION,
  packaged: app.isPackaged,
  loginItem: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
  state,
  shortcuts: { toggle: "⌘⇧R", pause: "⌘⇧P" },
}));

const JUNK_WINDOWS = new Set(["", "Recordius", "Dock", "Window Server", "Menubar", "Item-0", "StatusIndicator", "Notification Center", "Control Center"]);

ipcMain.handle("panel:sources", async () => {
  // Without permission macOS returns an empty list (no error) and silently registers the app
  // in System Settings → Screen & System Audio Recording.
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).catch(() => {});
    if (systemPreferences.getMediaAccessStatus("screen") !== "granted") return { screens: [], windows: [], error: "screen-permission" };
  }
  let screens, windows;
  try {
    // 560 px is plenty for a 300 px-wide card on a Retina panel and is noticeably faster to grab.
    [screens, windows] = await Promise.all([
      desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 560, height: 350 } }),
      desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: true }),
    ]);
  } catch (err) {
    return { screens: [], windows: [], error: err.message };
  }
  lastSources = [...screens, ...windows];
  const displays = screen.getAllDisplays();
  const ownTitles = new Set(BrowserWindow.getAllWindows().map((w) => w.getTitle()));
  const seen = new Set();
  return {
    error: null,
    screens: screens.map((s, i) => {
      const d = displays.find((x) => String(x.id) === String(s.display_id));
      return {
        id: s.id,
        name: screens.length > 1 ? `Display ${i + 1}` : "Full screen",
        thumbnail: s.thumbnail.toDataURL(),
        size: d ? `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}` : null,
      };
    }),
    windows: windows
      .filter((w) => !JUNK_WINDOWS.has(w.name.trim()) && !ownTitles.has(w.name) && !w.name.startsWith("Recordius "))
      .filter((w) => (seen.has(w.id) ? false : seen.add(w.id)))
      .map((w) => ({ id: w.id, name: w.name.trim(), icon: w.appIcon && !w.appIcon.isEmpty() ? w.appIcon.resize({ width: 36 }).toDataURL() : null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
});

ipcMain.on("panel:resize", (_e, height) => {
  if (!win.panel || !Number.isFinite(height)) return;
  const area = screen.getDisplayMatching(win.panel.getBounds()).workArea;
  const h = Math.min(Math.max(height, 200), area.height - 20);
  win.panel.setContentSize(PANEL_WINDOW, h);
  const [x, y] = win.panel.getPosition();
  if (y + h > area.y + area.height) win.panel.setPosition(x, Math.max(area.y, area.y + area.height - h));
});
ipcMain.on("panel:relaunch", () => {
  app.relaunch();
  app.exit(0);
});
ipcMain.on("panel:camera-preview", (_e, { enabled, cameraId }) => {
  // A preview request can arrive right after the panel was hidden; never let it resurrect the bubble.
  const panelShown = Boolean(win.panel && !win.panel.isDestroyed() && win.panel.isVisible()) && (panelShowStamp > panelHideStamp || Date.now() - panelHideStamp > 1500);
  if (enabled && panelShown && state === "idle") showCamera(cameraId);
  else if (!enabled) hideCamera();
});
ipcMain.on("panel:start", (_e, opts) => startRecording(opts));
ipcMain.on("panel:settings", (_e, patch) => {
  const allowed = ["source", "sourceId", "cameraId", "micId", "systemAudio", "mirrorCamera", "countdown", "quality", "cameraSize"];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  config.save(clean);
  if ("mirrorCamera" in clean) win.camera?.webContents.send("camera:mirror", clean.mirrorCamera);
  if ("cameraSize" in clean) resizeCamera(clean.cameraSize);
});
ipcMain.on("panel:login-item", (_e, enabled) => app.isPackaged && app.setLoginItemSettings({ openAtLogin: Boolean(enabled) }));
ipcMain.on("panel:close", () => hidePanel());
ipcMain.on("panel:library", () => openLibrary());
ipcMain.on("panel:open-url", (_e, url) => /^https?:\/\//.test(String(url)) && shell.openExternal(url));
ipcMain.on("panel:recordings-folder", () => shell.openPath(config.RECORDINGS_DIR));
ipcMain.on("panel:quit", () => app.quit());

ipcMain.handle("media:request", async (_e, kind) => {
  if (kind === "screen") {
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    return systemPreferences.getMediaAccessStatus("screen");
  }
  return systemPreferences.askForMediaAccess(kind);
});
ipcMain.handle("media:status", () => systemPreferences.getMediaAccessStatus("screen"));

// account
ipcMain.handle("account:open-connect", (_e, server) => {
  const base = normalizeServer(server);
  if (!base) throw new Error("Enter your workspace address, e.g. https://recordius.yourstudio.com");
  shell.openExternal(`${base}/download`);
  return base;
});
ipcMain.handle("account:paste-code", async (_e, code) => {
  const [server, token] = String(code ?? "")
    .trim()
    .split(/\s+/);
  await connect(server, token);
  return accountInfo();
});
ipcMain.handle("account:refresh", async () => {
  await refreshAccount();
  return accountInfo();
});
ipcMain.on("account:signout", () => signOut());

// updates
ipcMain.handle("update:check", () => updater.check());
ipcMain.handle("update:install", async (_e, info) => {
  await updater.install(info, (p) => win.panel?.webContents.send("update:progress", p));
  app.relaunch();
  app.exit(0);
});

// camera & controls
function resizeCamera(size) {
  if (!win.camera || !CAMERA_SIZES[size]) return;
  const [x, y] = win.camera.getPosition();
  const [, h] = win.camera.getSize();
  const px = CAMERA_SIZES[size] + BUBBLE_MARGIN * 2;
  win.camera.setBounds({ x, y: y + h - px, width: px, height: px }); // keep the bottom edge anchored
}
ipcMain.on("camera:size", (_e, size) => {
  config.save({ cameraSize: size });
  resizeCamera(size);
});
ipcMain.on("controls:stop", () => stopRecording());
ipcMain.on("controls:pause", () => togglePause());
ipcMain.on("controls:restart", () => cancelRecording({ restart: true }));
ipcMain.on("controls:cancel", () => cancelRecording());
ipcMain.on("controls:camera", () => toggleCameraBubble());
ipcMain.handle("controls:camera-state", () => ({ hasCamera: rec?.plan.mode === "screen-cam", visible: Boolean(win.camera?.isVisible()) }));

// recorder
ipcMain.on("rec:chunk", (_e, chunk) => rec?.uploader.push(Buffer.from(chunk)));
ipcMain.on("rec:thumbnail", (_e, jpeg) => {
  if (!rec) return;
  const { thumbPathname, thumbToken, access } = rec.video.upload;
  const id = rec.video.id;
  uploadThumbnail({ pathname: thumbPathname, token: thumbToken, access: access ?? "private" }, Buffer.from(jpeg))
    .then(() => api.markThumbnail(id))
    .catch((err) => console.warn("[main] thumbnail upload failed", err.message));
});

// ───────────────────────────── app ─────────────────────────────

if (!E2E && !app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", (_e, argv) => {
  const link = argv.find((a) => a.startsWith("recordius://"));
  if (link) handleDeepLink(link);
  else showPanel();
});
app.on("open-url", (e, url) => {
  e.preventDefault();
  if (app.isReady()) handleDeepLink(url);
  else pendingDeepLinks.push(url);
});
app.on("activate", () => showPanel());


app.setAsDefaultProtocolClient("recordius");

app.whenReady().then(async () => {
  app.setAboutPanelOptions({ applicationName: "Recordius", applicationVersion: VERSION, version: "" });
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      { label: "New recording…", click: () => showPanel() },
      { label: "Open my library", click: () => openLibrary() },
    ]),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Recordius", submenu: [{ role: "about" }, { type: "separator" }, { label: "Settings…", accelerator: "Cmd+,", click: () => showPanel("settings") }, { type: "separator" }, { role: "hide" }, { role: "quit" }] },
      { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "close" }] },
    ]),
  );

  // The recorder renderer asks for system audio via getDisplayMedia; answer with the chosen source.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
      const source = sources.find((s) => s.id === pendingSourceId) ?? sources.find((s) => s.id.startsWith("screen:"));
      callback(pendingSystemAudio ? { video: source, audio: "loopback" } : { video: source });
    },
    { useSystemPicker: false },
  );
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(["media", "display-capture", "clipboard-sanitized-write"].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ["media", "display-capture"].includes(permission));

  // Like Loom, start with the Mac by default (only once, so unticking it sticks).
  if (app.isPackaged && !config.load().loginItemConfigured) {
    app.setLoginItemSettings({ openAtLogin: true });
    config.save({ loginItemConfigured: true });
  }

  tray = new Tray(trayIcon());
  tray.setToolTip("Recordius");
  refreshTray();
  ensureRecorderWindow();
  ensurePanelWindow();

  globalShortcut.register(SHORTCUT_TOGGLE, () => {
    if (state === "recording" || state === "paused") stopRecording();
    else if (state === "idle") startRecording();
  });
  globalShortcut.register(SHORTCUT_PAUSE, () => togglePause());

  const atLogin = app.getLoginItemSettings().wasOpenedAtLogin || process.argv.includes("--hidden");
  if (!E2E && !atLogin) showPanel();
  for (const link of pendingDeepLinks.splice(0)) handleDeepLink(link);
  const argvLink = process.argv.find((a) => a.startsWith("recordius://"));
  if (argvLink) handleDeepLink(argvLink);

  refreshAccount();
  setInterval(refreshAccount, 6 * 60 * 60 * 1000);
});

app.on("window-all-closed", (e) => e.preventDefault()); // menu-bar app: keep running
app.on("will-quit", () => globalShortcut.unregisterAll());

if (E2E) require("./e2e-hooks")({ startRecording, stopRecording, togglePause, showPanel, hidePanel, connect, win, getState: () => state, getRec: () => rec, hostname: os.hostname() });
