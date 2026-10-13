// Drives the app for automated testing. Loaded only when RECORDIUS_E2E is set.
//   RECORDIUS_E2E=<mode>:<ms>       mode: cam | screen | screen-cam | ui
//   RECORDIUS_E2E_FAKE=1            Chromium's fake camera/microphone (no OS permissions needed)
//   RECORDIUS_E2E_CONNECT="<server> <token>"   connect before recording (otherwise the stored token is used)
//   RECORDIUS_E2E_OPTS=<json>       extra recording settings
//   RECORDIUS_E2E_OUT=<file>        where to write the JSON result
//   RECORDIUS_E2E_SHOTS=<dir>       save screenshots of the app's windows
const fs = require("node:fs");
const path = require("node:path");
const { app, desktopCapturer } = require("electron");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(w, name) {
  const dir = process.env.RECORDIUS_E2E_SHOTS;
  if (!dir || !w || w.isDestroyed()) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
  return file;
}

module.exports = ({ startRecording, stopRecording, togglePause, showPanel, hidePanel, connect, win, getState, getRec }) => {
  const [mode, msText] = process.env.RECORDIUS_E2E.split(":");
  const ms = Number(msText) || 6000;
  if (process.env.RECORDIUS_E2E_FAKE) {
    app.commandLine.appendSwitch("use-fake-device-for-media-stream");
    app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  }
  const out = (result) => {
    fs.writeFileSync(process.env.RECORDIUS_E2E_OUT || "/dev/stdout", JSON.stringify(result, null, 2));
    app.exit(result.ok ? 0 : 1);
  };

  const until = async (fn, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (fn()) return Date.now() - t0;
      await wait(20);
    }
    return null;
  };

  const runUi = async () => {
    const js = (code) => win.panel.webContents.executeJavaScript(code);
    const camVisible = () => Boolean(win.camera && !win.camera.isDestroyed() && win.camera.isVisible());
    const r = {};
    showPanel();
    await until(() => win.panel && !win.panel.webContents.isLoading());
    await wait(2500);
    r.view = await js(`document.body.dataset.view`);
    r.panelShot = await shot(win.panel, "panel");
    // open each row (accordion) and screenshot
    await js(`document.querySelector('[data-row="source"] .row-head').click()`);
    await wait(900);
    r.sourceOpen = await shot(win.panel, "panel-source-open");
    r.screenCount = await js(`document.querySelectorAll('[data-screen]').length`);
    r.windowCount = await js(`document.querySelectorAll('[data-window]').length`);
    await js(`document.querySelector('[data-row="source"] .row-head').click()`);
    await js(`document.querySelector('[data-row="camera"] .row-head').click()`);
    await wait(600);
    r.cameraOpen = await shot(win.panel, "panel-camera-open");
    r.cameraCount = await js(`document.querySelectorAll('[data-camera]').length`);
    r.cameraVisibleWhileIdle = camVisible();
    await js(`document.querySelector('[data-camera="none"]').click()`);
    r.cameraHiddenAfterOff = await until(() => !camVisible(), 3000);
    await js(`document.querySelector('[data-camera]:not([data-camera="none"])').click()`);
    r.cameraShownAgainMs = await until(camVisible, 8000);
    await js(`document.querySelector('[data-row="camera"] .row-head').click()`);
    await js(`document.querySelector('[data-row="mic"] .row-head').click()`);
    await wait(600);
    r.micOpen = await shot(win.panel, "panel-mic-open");
    r.micCount = await js(`document.querySelectorAll('[data-mic]').length`);
    await js(`document.querySelector('[data-row="mic"] .row-head').click()`);
    await js(`document.getElementById('openSettings').click()`);
    await wait(500);
    r.settingsShot = await shot(win.panel, "panel-settings");
    r.settingsView = await js(`document.body.dataset.view`);
    await js(`document.getElementById('settingsBack').click()`);
    await wait(300);
    r.startEnabled = await js(`!document.getElementById('start').disabled`);
    r.checksVisible = await js(`[...document.querySelectorAll('.opt .check')].filter((c) => getComputedStyle(c).display !== 'none').length`);
    await wait(2500); // let any pending source/device loads settle, like a user would
    hidePanel(); // what Esc / the close button do
    r.cameraHiddenWithPanel = await until(() => !camVisible(), 3000);
    await wait(1500);
    r.cameraStillHidden = !camVisible();
    out({ ok: true, ui: r });
  };

  const runSignedOut = async () => {
    showPanel();
    await until(() => win.panel && !win.panel.webContents.isLoading());
    await wait(1200);
    const view = await win.panel.webContents.executeJavaScript(`document.body.dataset.view`);
    const shotFile = await shot(win.panel, "panel-signin");
    out({ ok: view === "signin", view, shot: shotFile });
  };

  app.whenReady().then(async () => {
    try {
      await wait(1200);
      if (process.env.RECORDIUS_E2E_CONNECT) {
        const [server, token] = process.env.RECORDIUS_E2E_CONNECT.split(/\s+/);
        await connect(server, token);
      }
      if (mode === "ui") return await runUi();
      if (mode === "update") {
        const updater = require("./updater");
        const info = await updater.check();
        if (!info.available) return out({ ok: false, error: "no update available", info });
        let progress = 0;
        await updater.install(info, (p) => (progress = p));
        return out({ ok: true, info: { current: info.current, latest: info.latest }, progress });
      }
      if (mode === "signin") return await runSignedOut();

      const shots = {};
      const sourceId = mode === "cam" ? null : (await desktopCapturer.getSources({ types: ["screen"] }))[0]?.id;
      startRecording({
        source: mode === "cam" ? "camera" : "screen",
        sourceId,
        cameraId: mode === "screen" ? "none" : null,
        micId: process.env.RECORDIUS_E2E_FAKE ? null : "none",
        systemAudio: false,
        countdown: false,
        ...JSON.parse(process.env.RECORDIUS_E2E_OPTS || "{}"),
      });
      const deadline = Date.now() + 30000;
      let seenPreparing = false;
      while (getState() !== "recording") {
        if (getState() === "preparing") seenPreparing = true;
        if ((seenPreparing && getState() === "idle") || Date.now() > deadline) throw new Error(`recording did not start (state=${getState()})`);
        await wait(100);
      }
      const rec = getRec();
      const startedAt = Date.now();
      await wait(ms / 2);
      shots.controls = await shot(win.controls, "controls");
      shots.camera = await shot(win.camera, "camera");
      togglePause();
      await wait(600);
      shots.controlsPaused = await shot(win.controls, "controls-paused");
      await wait(1500);
      togglePause();
      await wait(ms / 2);
      const uploader = rec.uploader;
      const liveParts = uploader.parts.length;
      await stopRecording();
      out({
        ok: true,
        mode,
        shareUrl: rec.video.shareUrl,
        id: rec.video.id,
        mimeType: rec.mimeType,
        localPath: rec.localPath,
        totalBytes: uploader.totalBytes,
        partsUploadedBeforeStop: liveParts,
        live: uploader.live,
        shots,
        wallMs: Date.now() - startedAt,
      });
    } catch (err) {
      out({ ok: false, error: String(err?.stack || err) });
    }
  });
};
