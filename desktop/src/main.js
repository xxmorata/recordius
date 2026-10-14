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
  powerMonitor,
} = require("electron");
const config = require("./config");
require("./http").useForVercelBlob(); // uploads to Vercel Blob use the browser's network stack too
const api = require("./api");
const updater = require("./updater");
const { LiveUploader, uploadTarget, uploadFile, uploadThumbnail } = require("./uploader");
const library = require("./library");

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
const CONTROLS_WIDTH = 60; // bar is 52 px; the window hugs it (no shadow to make room for)
const E2E = Boolean(process.env.RECORDIUS_E2E);
// A stray error must never take the recorder down or pop up Electron's crash dialog mid-recording: log it.
process.on("uncaughtException", (err) => console.error("[recordius] unexpected error", err));
process.on("unhandledRejection", (err) => console.error("[recordius] unhandled promise rejection", err));
const log = (...args) => process.env.RECORDIUS_DEBUG && console.log("[recordius]", ...args);

/** @type {"idle"|"preparing"|"recording"|"paused"|"stopping"} */
let state = "idle";
let rec = null; // active recording session
const uploadingIds = new Set(); // uploads in progress right now (live finish or retry)
let retrying = null;
let pendingCount = 0; // cached: the tray menu is rebuilt twice a second while recording
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
let quitting = false; // set on before-quit so windows that normally just hide let the app quit
let pausedForSleep = false;

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
    if (quitting) return; // Quit, ⌘Q, logout and shutdown must be able to close it
    // ⌘W / window close keeps the (hidden) window around so the next open stays instant.
    e.preventDefault();
    hidePanel();
  });
  // The preview bubble belongs to the panel: it goes away when the panel is hidden (⌘H, close) or
  // simply loses focus (another app in front), and comes back when the panel is focused again.
  // macOS sometimes reports "hide" right after a show, or "show"/"focus" twice: tell the panel only what's
  // actually true, so the camera and microphone are on exactly while the panel is in front.
  const inFront = (front) => {
    const really = w.isVisible() && !w.isMinimized();
    if (front ? really : !really || !w.isFocused()) w.webContents.send("panel:visibility", front);
  };
  w.on("show", () => {
    panelShowStamp = Date.now();
    inFront(true);
  });
  w.on("focus", () => {
    panelShowStamp = Date.now();
    inFront(true);
  });
  w.on("hide", () => {
    // A spurious "hide" for a visible window is ignored; a real one that's merely reported early is re-checked.
    if (w.isVisible()) return setTimeout(() => !w.isDestroyed() && !w.isVisible() && inFront(false), 400);
    panelHideStamp = Date.now();
    inFront(false);
    if (state === "idle") hideCamera();
  });
  // Behind another app or minimized: release the camera and the mic meter too, so the macOS camera/mic
  // indicators go off. (Automated runs aren't frontmost, so they'd blur all the time — except the devices test.)
  const notInFront = () => {
    if (E2E && !process.env.RECORDIUS_E2E.startsWith("devices")) return;
    if (w.isFocused() && !w.isMinimized()) return;
    inFront(false);
    if (state === "idle") hideCamera();
  };
  w.on("blur", notInFront);
  w.on("minimize", notInFront);
  w.on("restore", () => w.isFocused() && inFront(true));
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
    if (w.isMinimized()) w.restore();
    w.focus();
    // Electron doesn't reliably emit "show" for this pre-created window, and "focus" only fires when the
    // app is frontmost — tell the panel directly, so it always loads screens and devices when it opens.
    panelShowStamp = Date.now();
    w.webContents.send("panel:visibility", true);
    if (view) w.webContents.send("panel:navigate", view);
  };
  if (w.webContents.isLoading()) w.once("ready-to-show", reveal);
  else reveal();
}

function hidePanel() {
  if (win.panel && !win.panel.isDestroyed()) {
    win.panel.hide();
    panelHideStamp = Date.now();
    win.panel.webContents.send("panel:visibility", false); // don't wait for the window event: mic and camera off now
  }
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
    { width: CONTROLS_WIDTH, height: 380, x: display.workArea.x + 16, y: Math.round(display.workArea.y + display.workArea.height / 2 - 190), transparent: true, hasShadow: false, alwaysOnTop: true },
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
  if (win.recorder && !win.recorder.isDestroyed()) return win.recorder;
  const w = createWindow("recorder", { width: 400, height: 300 }, "recorder.html");
  // If the capture process dies mid-recording, finish with what was recorded and start a fresh one.
  w.webContents.on("render-process-gone", (_e, details) => {
    console.error("[main] recorder process gone", details.reason);
    if (win.recorder === w) win.recorder = null;
    if (!w.isDestroyed()) w.destroy();
    if (state === "recording" || state === "paused") {
      notify("Recording stopped", "Recordius' recorder stopped unexpectedly. Everything recorded until now is being uploaded.");
      stopRecording({ recorderGone: true });
    }
  });
  return w;
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

/** Just the timer next to the menu-bar icon (cheap; runs while recording). */
function updateTrayTitle() {
  if (!tray) return;
  const recording = state === "recording" || state === "paused";
  tray.setTitle(recording ? ` ${state === "paused" ? "❚❚" : "●"} ${fmt(elapsedMs())}` : "");
}

/** Rebuilds the menu — only when state, account or queue change. */
function refreshTray() {
  if (!tray) return;
  const recording = state === "recording" || state === "paused";
  updateTrayTitle();
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
    ...(pendingCount ? [{ label: `Retry failed uploads (${pendingCount})`, click: () => retryFailedUploads({ manual: true }) }] : []),
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
      updateTrayTitle();
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
    const testProxy = E2E && Boolean(process.env.RECORDIUS_E2E_PROXY); // the proxy test serves plain HTTP on a fake host
    if (u.protocol !== "https:" && !testProxy && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return null;
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
  pendingChanged();
  setTimeout(() => failedUploads().length && retryFailedUploads(), 1000);
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
      pendingChanged();
      notify("Recordius was disconnected", "This Mac was removed from your account. Connect it again from the web app.");
    }
  }
}

function signOut() {
  config.clearToken();
  config.save({ account: null });
  win.panel?.webContents.send("account:changed", accountInfo());
  pendingChanged();
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
    connectFromLink(url.searchParams.get("server"), url.searchParams.get("token"), url.searchParams.get("state")).catch((err) => {
      dialog.showErrorBox("Couldn't connect Recordius", err.message);
    });
  } else {
    // Other links only bring the app forward: no website can start or stop a recording.
    showPanel();
  }
}

/**
 * Any web page can open recordius:// links, so a connect link is only trusted silently when it carries the
 * one-time code from the "Continue in browser" step the user just took in this app. Anything else needs
 * an explicit OK in a native dialog that names the server.
 */
let pendingConnect = null; // { state, until }

function startConnect(base) {
  pendingConnect = { state: require("node:crypto").randomBytes(16).toString("hex"), base, until: Date.now() + 30 * 60 * 1000 };
  return pendingConnect.state;
}

async function connectFromLink(server, token, state) {
  const base = normalizeServer(server);
  if (!base || !token) throw new Error("That connection link isn't valid");
  // Trusted only for the server the code was issued for; anything else (another host, an alias) asks.
  const trusted = Boolean(pendingConnect && pendingConnect.until > Date.now() && state === pendingConnect.state && base === pendingConnect.base);
  if (!trusted) {
    const current = config.isConnected() ? config.load().server : null;
    const host = new URL(base).host;
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Cancel", "Connect"],
      defaultId: 0,
      cancelId: 0,
      message: `Connect Recordius to ${host}?`,
      detail:
        `A web page asked to connect this Mac to ${host}. Only continue if you just clicked “Connect desktop app” on that site yourself — your recordings will be uploaded there.` +
        (current && current !== base ? `\n\nThis replaces your connection to ${new URL(current).host}.` : ""),
    });
    if (response !== 1) return;
  }
  pendingConnect = null;
  await connect(base, token);
}

async function openLibrary() {
  const server = api.serverUrl();
  if (server) openWeb(`${server}/library`);
}

/** Opens a web page in the browser — never another kind of URL (file:, smb:, app schemes…). */
function openWeb(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === "https:" || u.protocol === "http:") shell.openExternal(u.toString());
  } catch {}
}

/**
 * The upload session from the server, checked before it's used for file names and links: a misbehaving
 * server must not be able to make the app write outside ~/Movies/Recordius or open arbitrary URLs.
 */
function checkedVideo(video) {
  if (!video || !/^[a-f0-9]{32}$/.test(String(video.id))) throw new Error("The server sent an invalid video id");
  const ext = String(video.upload?.videoPathname ?? "").split(".").pop();
  if (!["mp4", "webm"].includes(ext)) throw new Error("The server sent an unexpected file type");
  return { ...video, ext, shareUrl: `${api.serverUrl()}/share/${video.id}` };
}

// ───────────────────────────── recording lifecycle ─────────────────────────────

const openRecorderRequests = new Set();

/** Cancelling a recording that's still starting: stop waiting for the recorder (it gives up on its side too). */
function abortRecorderRequests() {
  for (const abort of [...openRecorderRequests]) abort();
}

/** Asks the hidden recorder window for something; never waits forever (a crashed renderer never answers). */
function recorderRequest(channel, payload, reply, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(Object.assign(new Error("cancelled"), { cancelled: true }));
    };
    const ok = (_e, data) => {
      cleanup();
      resolve(data);
    };
    const fail = (_e, message) => {
      cleanup();
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`the recorder didn't answer (${channel})`));
    }, timeoutMs);
    const cleanup = () => {
      openRecorderRequests.delete(abort);
      clearTimeout(timer);
      ipcMain.removeListener(reply, ok);
      ipcMain.removeListener("rec:error", fail);
    };
    ipcMain.once(reply, ok);
    ipcMain.once("rec:error", fail);
    openRecorderRequests.add(abort);
    const recorder = ensureRecorderWindow();
    if (recorder.isDestroyed()) return fail(null, "the recorder window is gone");
    recorder.webContents.send(channel, payload);
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
  setState("preparing");
  hidePanel(); // releases the panel's mic meter before the recorder opens the mic

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
    const video = checkedVideo(await api.createVideo(defaultTitle(), prepared.mimeType));
    log("session created", video.id);
    if (state !== "preparing") {
      // Cancelled while we were preparing: nothing to keep.
      win.recorder?.webContents.send("rec:discard");
      api.deleteVideo(video.id).catch(() => {});
      return;
    }
    fs.mkdirSync(config.RECORDINGS_DIR, { recursive: true });
    const ext = video.ext;
    const localPath = path.join(config.RECORDINGS_DIR, `${stamp()} ${video.id}.${ext}`);
    rec = {
      video,
      plan,
      display,
      localPath,
      mimeType: prepared.mimeType,
      target: uploadTarget(video.upload, video.id, api.upload),
      startedAt: 0,
      pausedAt: 0,
      pausedTotal: 0,
    };
    rec.settings = settings; // what the user chose (restart uses this, not the derived plan)
    rec.uploader = new LiveUploader({ target: rec.target, contentType: prepared.mimeType.split(";")[0], localPath });
    // Queued from the very start: if the app crashes, the Mac shuts down or Recordius is quit while
    // recording, the next start finds the local file and finishes the upload. Not retried meanwhile.
    uploadingIds.add(video.id);
    safely(() =>
      library.addPending({ id: video.id, server: api.serverUrl(), account: config.load().account?.email ?? null, localPath, durationMs: 0, recordingStartedAt: Date.now(), title: video.title, shareUrl: video.shareUrl, contentType: prepared.mimeType.split(";")[0], failedAt: Date.now() }),
    );
    if (prepared.warning) notify("Recordius", prepared.warning);
    await countdown;
    await cameraReady; // never start recording before the bubble shows a picture
    if (state !== "preparing" || rec?.video.id !== video.id) return; // cancelled meanwhile (cancelRecording cleaned up)
    await recorderRequest("rec:start", null, "rec:started");
    rec.startedAt = Date.now();
    showControls(display);
    setState("recording");
  } catch (err) {
    if (err.cancelled) return; // cancelled while starting: cancelRecording cleaned up
    console.error("[main] start failed", err);
    if (win.countdown && !win.countdown.isDestroyed()) win.countdown.close();
    hideCamera();
    win.recorder?.webContents.send("rec:discard");
    if (rec) {
      rec.uploader.abort();
      forgetRecording(rec);
      api.deleteVideo(rec.video.id).catch(() => {});
      rec = null;
    }
    setState("idle");
    const text = err.status === 401 ? "This Mac is no longer connected. Open Recordius and connect it again." : err.message;
    notify("Couldn't start recording", text);
    showPanel();
  }
}

async function stopRecording({ recorderGone = false } = {}) {
  if (state !== "recording" && state !== "paused") return;
  const sessionRec = rec;
  const durationMs = elapsedMs();
  setState("stopping");
  win.controls?.close();
  hideCamera();
  // A crashed recorder can't answer; everything it sent before is already in the uploader.
  if (!recorderGone) await recorderRequest("rec:stop", null, "rec:stopped").catch((err) => console.error("[main] stop", err));
  rec = null;
  setState("idle");

  // Nothing reached us (stopped or crashed within the first moments): there's no video to share.
  if (sessionRec.uploader.totalBytes === 0) {
    sessionRec.uploader.abort();
    forgetRecording(sessionRec);
    api.deleteVideo(sessionRec.video.id).catch(() => {});
    notify("Nothing was recorded", "The recording stopped before any video was captured. Try again.");
    return;
  }

  // Exactly Loom's openSharePageAndCopyUrl: the link is ready the moment you stop.
  if (!E2E) {
    clipboard.writeText(sessionRec.video.shareUrl);
    openWeb(sessionRec.video.shareUrl);
  }
  notify("Link copied to clipboard", "Finishing the upload — your video will play in a few seconds.");
  await finishUpload(sessionRec, durationMs);
}

/** Runs a bookkeeping write that must never break a recording or an upload (disk full, permissions…). */
function safely(fn) {
  try {
    return fn();
  } catch (err) {
    console.error("[main] couldn't update the upload queue", err.message);
  }
}

/** A cancelled or failed-to-start recording: delete its local file and queue entry. */
function forgetRecording(sessionRec) {
  uploadingIds.delete(sessionRec.video.id);
  safely(() => library.removePending(sessionRec.video.id));
  fs.rm(sessionRec.localPath, { force: true }, () => {});
}

async function finishUpload(sessionRec, durationMs) {
  const { video, localPath } = sessionRec;
  // Written before the upload finishes, so quitting or a crash mid-upload is retried on the next start.
  safely(() => library.addPending({ id: video.id, server: api.serverUrl(), account: config.load().account?.email ?? null, localPath, durationMs, title: video.title, shareUrl: video.shareUrl, contentType: sessionRec.mimeType?.split(";")[0], failedAt: Date.now() }));
  uploadingIds.add(video.id);
  try {
    await sessionRec.uploader.finish();
    await api.completeVideo(video.id, durationMs, sessionRec.uploader.totalBytes);
    library.removePending(video.id);
    library.markUploaded(video.id, localPath);
    notify("Your video is ready", video.title ?? video.shareUrl, () => openWeb(video.shareUrl));
    win.panel?.webContents.send("panel:recent-changed");
  } catch (err) {
    console.error("[main] upload failed", err);
    safely(() => library.updatePending(video.id, { failedAt: Date.now(), error: err.message }));
    notify("Upload didn’t finish", "Your recording is saved on this Mac. Recordius will keep retrying — or click Retry in the app.");
  } finally {
    uploadingIds.delete(video.id);
  }
  pendingChanged();
}

/** Failed uploads of the account this Mac is connected to now (other accounts' stay queued for them). */
function failedUploads() {
  if (!config.isConnected()) return [];
  const server = api.serverUrl();
  const account = config.load().account?.email ?? null;
  return library.pending().filter((p) => p.server === server && (!p.account || !account || p.account === account) && !uploadingIds.has(p.id));
}

function pendingChanged() {
  pendingCount = failedUploads().length;
  refreshTray();
  win.panel?.webContents.send("panel:pending", pendingCount);
}

/**
 * Uploads recordings whose upload failed, from the local copy, with fresh upload tokens.
 * Runs on start, every few minutes and from the Retry button; only one run at a time.
 */
function retryFailedUploads({ manual = false } = {}) {
  if (retrying) return retrying;
  retrying = (async () => {
    let done = 0;
    let lastError = null;
    const attempted = new Set();
    // Re-read the queue after each item: uploads that fail while this runs are picked up too.
    for (let p = failedUploads()[0]; p; p = failedUploads().find((x) => !attempted.has(x.id))) {
      attempted.add(p.id);
      if (state !== "idle" && state !== "stopping" && !manual) break; // don't compete with a live recording for bandwidth
      if (!fs.existsSync(p.localPath)) {
        library.removePending(p.id); // the only copy is gone; nothing left to upload
        continue;
      }
      if (fs.statSync(p.localPath).size === 0) {
        // Interrupted before the first second was written: there is no video to upload.
        library.removePending(p.id);
        fs.rm(p.localPath, { force: true }, () => {});
        api.deleteVideo(p.id).catch(() => {});
        continue;
      }
      uploadingIds.add(p.id);
      try {
        let upload;
        try {
          ({ upload } = await api.uploadToken(p.id));
        } catch (err) {
          // Only explicit answers drop an entry: a plain 404 could also be an older server without this route.
          if (err.code === "video_gone") {
            library.removePending(p.id); // deleted on the web
            continue;
          }
          if (err.code === "already_uploaded") {
            library.removePending(p.id); // finished after all (e.g. the response got lost)
            library.markUploaded(p.id, p.localPath);
            continue;
          }
          throw err;
        }
        const ext = path.extname(p.localPath).slice(1);
        await uploadFile(uploadTarget(upload, p.id, api.upload), p.localPath, p.contentType ?? (ext === "webm" ? "video/webm" : "video/mp4"));
        const info = fs.statSync(p.localPath);
        // Interrupted mid-recording (crash, quit): the length is roughly from start to the last write.
        const durationMs = p.durationMs || Math.max(1000, info.mtimeMs - (p.recordingStartedAt ?? info.birthtimeMs));
        await api.completeVideo(p.id, durationMs, info.size);
        library.removePending(p.id);
        library.markUploaded(p.id, p.localPath);
        done++;
        notify("Upload finished", p.title ?? p.shareUrl, () => openWeb(p.shareUrl));
      } catch (err) {
        lastError = err;
        library.updatePending(p.id, { failedAt: Date.now(), error: err.message });
      } finally {
        uploadingIds.delete(p.id);
      }
    }
    if (done) win.panel?.webContents.send("panel:recent-changed");
    if (manual && lastError) notify("Couldn’t upload yet", lastError.status === 0 ? "You seem to be offline. Recordius will try again automatically." : lastError.message);
    return { done, remaining: failedUploads().length, error: lastError?.message ?? null };
  })().finally(() => {
    retrying = null;
    pendingChanged();
  });
  return retrying;
}

function cleanUpLocalCopies() {
  const deleted = library.cleanUpLocalCopies({ keepDays: Number(config.load().keepLocalDays) || 0, activePath: rec?.localPath ?? null });
  if (deleted) log(`removed ${deleted} old local recordings`);
}

async function cancelRecording({ restart = false } = {}) {
  if (!["preparing", "recording", "paused"].includes(state)) return;
  const sessionRec = rec;
  const settings = sessionRec?.settings ?? config.load();
  rec = null;
  win.controls?.close();
  if (win.countdown && !win.countdown.isDestroyed()) win.countdown.close();
  if (!restart) hideCamera();
  win.recorder?.webContents.send("rec:discard");
  abortRecorderRequests();
  setState("idle");
  if (sessionRec) {
    sessionRec.uploader.abort();
    forgetRecording(sessionRec);
    api.deleteVideo(sessionRec.video.id).catch(() => {});
  }
  if (restart) setTimeout(() => startRecording(settings), 300);
}

function togglePause() {
  if (state === "recording") {
    rec.pausedAt = Date.now();
    win.recorder?.webContents.send("rec:pause");
    setState("paused");
  } else if (state === "paused") {
    rec.pausedTotal += Date.now() - rec.pausedAt;
    rec.pausedAt = 0;
    win.recorder?.webContents.send("rec:resume");
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
  visible: Boolean(win.panel && !win.panel.isDestroyed() && win.panel.isVisible()),
  pendingUploads: failedUploads().length,
  shortcuts: { toggle: "⌘⇧R", pause: "⌘⇧P" },
}));

// App icons don't change while we run: resize + encode each distinct icon once (keyed by its pixels).
const iconCache = new Map();
function appIconUrl(w) {
  if (!w.appIcon || w.appIcon.isEmpty()) return null;
  const key = require("node:crypto").createHash("md5").update(w.appIcon.toBitmap()).digest("hex");
  if (!iconCache.has(key)) iconCache.set(key, w.appIcon.resize({ width: 36 }).toDataURL());
  return iconCache.get(key);
}

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
    // macOS can hold capture back even with the permission on (e.g. while its periodic "allow Recordius
    // to keep recording your screen?" question is waiting): never let the panel wait forever.
    let timer;
    const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("screen-blocked")), 8000)));
    [screens, windows] = await Promise.race([
      Promise.all([
        desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 560, height: 350 } }),
        desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: true }),
      ]),
      timeout,
    ]).finally(() => clearTimeout(timer));
  } catch (err) {
    return { screens: [], windows: [], error: err.message === "screen-blocked" ? "screen-blocked" : err.message };
  }
  if (!screens.length) return { screens: [], windows: [], error: "screen-blocked" };
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
        // JPEG: several times faster to encode than PNG and smaller to send to the panel.
        thumbnail: `data:image/jpeg;base64,${s.thumbnail.toJPEG(80).toString("base64")}`,
        size: d ? `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}` : null,
      };
    }),
    windows: windows
      .filter((w) => !JUNK_WINDOWS.has(w.name.trim()) && !ownTitles.has(w.name) && !w.name.startsWith("Recordius "))
      .filter((w) => (seen.has(w.id) ? false : seen.add(w.id)))
      .map((w) => ({ id: w.id, name: w.name.trim(), icon: appIconUrl(w) }))
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
  else if (!enabled && state === "idle") hideCamera(); // while recording the bubble belongs to the recording
});
ipcMain.on("panel:start", (_e, opts) => startRecording(opts));
ipcMain.on("panel:settings", (_e, patch) => {
  const allowed = ["source", "sourceId", "cameraId", "micId", "systemAudio", "mirrorCamera", "countdown", "quality", "cameraSize", "keepLocalDays"];
  if ("keepLocalDays" in patch && ![0, 7, 30].includes(patch.keepLocalDays)) delete patch.keepLocalDays;
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  config.save(clean);
  if ("mirrorCamera" in clean) win.camera?.webContents.send("camera:mirror", clean.mirrorCamera);
  if ("cameraSize" in clean) resizeCamera(clean.cameraSize);
  if ("keepLocalDays" in clean) cleanUpLocalCopies();
});
ipcMain.handle("panel:retry-uploads", () => retryFailedUploads({ manual: true }));
ipcMain.on("panel:login-item", (_e, enabled) => app.isPackaged && app.setLoginItemSettings({ openAtLogin: Boolean(enabled) }));
ipcMain.on("panel:close", () => hidePanel());
ipcMain.on("panel:library", () => openLibrary());
ipcMain.handle("panel:recent", async () => {
  const server = api.serverUrl();
  const { videos } = await api.recent(4);
  const waiting = new Set(library.pending().map((p) => p.id));
  return videos.map((v) => ({
    waiting: v.status !== "ready" && waiting.has(v.id),
    id: v.id,
    title: v.title,
    status: v.status,
    durationMs: v.durationMs,
    createdAt: v.createdAt,
    thumbUrl: v.thumbUrl,
    shareUrl: `${server}/share/${v.id}`,
  }));
});
ipcMain.handle("panel:copy", (_e, text) => {
  clipboard.writeText(String(text ?? ""));
  return true;
});
ipcMain.on("panel:open-url", (_e, url) => openWeb(url));
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
  shell.openExternal(`${base}/download?connect=${startConnect(base)}`);
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
// The renderer only asks; what gets installed is always the main process's own check result.
let lastUpdateCheck = null;
ipcMain.handle("update:check", async () => (lastUpdateCheck = await updater.check()));
ipcMain.handle("update:install", async () => {
  const info = lastUpdateCheck?.available ? lastUpdateCheck : await updater.check();
  if (!info.available) throw new Error("No update is available");
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
ipcMain.on("controls:size", (_e, barHeight) => {
  const w = win.controls;
  if (!w || w.isDestroyed() || !Number.isFinite(barHeight)) return;
  const height = Math.min(Math.max(Math.round(barHeight) + 8, 120), 600);
  const [, oldHeight] = w.getContentSize();
  if (oldHeight === height) return;
  const [x, y] = w.getPosition();
  w.setContentSize(CONTROLS_WIDTH, height);
  w.setPosition(x, Math.round(y + (oldHeight - height) / 2)); // stay centred where it was
});
ipcMain.handle("controls:camera-state", () => ({ hasCamera: rec?.plan.mode === "screen-cam", visible: Boolean(win.camera?.isVisible()) }));

// recorder
ipcMain.on("rec:chunk", (_e, chunk) => rec?.uploader.push(Buffer.from(chunk)));
// The recorded window was closed / display unplugged, or the encoder failed: stop and keep what's there.
ipcMain.on("rec:source-ended", () => {
  if (state !== "recording" && state !== "paused") return;
  notify("Recording stopped", "What you were recording went away (window closed or display disconnected). Your video is being uploaded.");
  stopRecording();
});
ipcMain.on("rec:failed", (_e, message) => {
  if (state !== "recording" && state !== "paused") return;
  console.error("[main] recorder failed", message);
  notify("Recording stopped", `The recorder ran into a problem (${message}). Everything until now is being uploaded.`);
  stopRecording();
});
ipcMain.on("rec:thumbnail", (_e, jpeg) => {
  if (!rec) return;
  const id = rec.video.id;
  uploadThumbnail(rec.target, Buffer.from(jpeg))
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
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
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
  pendingCount = failedUploads().length;
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

  // Finish uploads that failed earlier (also after a crash or quitting mid-upload), then keep trying.
  if (!E2E || process.env.RECORDIUS_E2E_RETRY) {
    setTimeout(() => config.isConnected() && retryFailedUploads(), E2E ? 500 : 8000);
    setInterval(() => config.isConnected() && failedUploads().length && retryFailedUploads(), 5 * 60 * 1000);
    powerMonitor.on("resume", () => setTimeout(() => config.isConnected() && failedUploads().length && retryFailedUploads(), 15000));
  }
  // Lid closed / sleep mid-recording: pause, so the video (and its length) doesn't include the sleep.
  powerMonitor.on("suspend", () => {
    if (state === "recording") {
      togglePause();
      pausedForSleep = true;
    }
  });
  powerMonitor.on("resume", () => {
    if (pausedForSleep && state === "paused") notify("Recording paused", "Your Mac went to sleep, so Recordius paused the recording. Press ⌘⇧P to continue or ⌘⇧R to finish.");
    pausedForSleep = false;
  });
  setTimeout(cleanUpLocalCopies, 20000);
  setInterval(cleanUpLocalCopies, 24 * 60 * 60 * 1000);
});

app.on("window-all-closed", (e) => e.preventDefault()); // menu-bar app: keep running
// Quitting (⌘Q, menu, logout, shutdown) while recording: stop the recorder and close the local file first,
// so the recording is complete on disk. Its queue entry (written at start) makes the next start upload it.
let quitAfterRecording = false;
app.on("before-quit", (e) => {
  quitting = true;
  if ((state !== "recording" && state !== "paused") || quitAfterRecording || !rec) return;
  e.preventDefault();
  quitAfterRecording = true;
  const sessionRec = rec;
  const durationMs = elapsedMs();
  setState("stopping");
  recorderRequest("rec:stop", null, "rec:stopped", 10000)
    .catch(() => {})
    .then(() => sessionRec.uploader.closeFile())
    .then(() => safely(() => library.updatePending(sessionRec.video.id, { durationMs, failedAt: Date.now(), error: "Recordius was quit while recording" })))
    .finally(() => app.quit());
});
app.on("will-quit", () => globalShortcut.unregisterAll());

if (E2E) require("./e2e-hooks")({ startRecording, stopRecording, cancelRecording, togglePause, showPanel, hidePanel, connect, win, getState: () => state, getRec: () => rec, retryFailedUploads, handleDeepLink, startConnect, hostname: os.hostname() });
