// Drives the app for automated testing. Loaded only when RECORDIUS_E2E is set.
//   RECORDIUS_E2E=<mode>:<ms>       mode: cam | screen | screen-cam | ui | signin | update | retry
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

module.exports = ({ startRecording, stopRecording, togglePause, showPanel, hidePanel, connect, win, getState, getRec, retryFailedUploads }) => {
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
    r.recentCount = await js(`document.querySelectorAll('.recent-item').length`);
    r.recentShot = await shot(win.panel, "panel-recent");
    r.checksVisible = await js(`[...document.querySelectorAll('.opt .check')].filter((c) => getComputedStyle(c).display !== 'none').length`);
    await wait(2500); // let any pending source/device loads settle, like a user would
    hidePanel(); // what Esc / the close button do
    r.cameraHiddenWithPanel = await until(() => !camVisible(), 3000);
    await wait(1500);
    r.cameraStillHidden = !camVisible();
    out({ ok: true, ui: r });
  };

  /** Failed uploads: survive a restart (they're on disk), show a banner, upload with fresh tokens, clean up their queue. */
  const runRetry = async () => {
    const api = require("./api");
    const library = require("./library");
    const config = require("./config");
    const js = (code) => win.panel.webContents.executeJavaScript(code);
    const r = {};
    const dir = path.join(config.DIR, "e2e-recordings");
    fs.mkdirSync(dir, { recursive: true });
    // 1) a real recording whose upload "failed": the server has the session, the file is only local
    const video = await api.createVideo("E2E retry", "video/mp4");
    const file = path.join(dir, `2026-01-01 00.00.00 ${video.id}.mp4`);
    fs.writeFileSync(file, Buffer.alloc(6 * 1024 * 1024 + 123, 9)); // > 1 multipart part
    library.addPending({ id: video.id, server: api.serverUrl(), localPath: file, durationMs: 3210, title: video.title, shareUrl: video.shareUrl, contentType: "video/mp4", failedAt: Date.now() });
    // 2) a video deleted on the web meanwhile, 3) a local file that's gone
    const gone = await api.createVideo("E2E deleted", "video/mp4");
    await api.deleteVideo(gone.id);
    const goneFile = path.join(dir, `x ${gone.id}.mp4`);
    fs.writeFileSync(goneFile, "x");
    library.addPending({ id: gone.id, server: api.serverUrl(), localPath: goneFile, durationMs: 1, shareUrl: gone.shareUrl, failedAt: Date.now() });
    library.addPending({ id: "f".repeat(32), server: api.serverUrl(), localPath: path.join(dir, "missing.mp4"), durationMs: 1, shareUrl: "x", failedAt: Date.now() });
    // a recording for another workspace must be left alone
    library.addPending({ id: "e".repeat(32), server: "https://elsewhere.example", localPath: file, durationMs: 1, shareUrl: "x", failedAt: Date.now() });
    // …and so must one recorded by another account on this server
    library.addPending({ id: "d".repeat(32), server: api.serverUrl(), account: "someone-else@example.com", localPath: file, durationMs: 1, shareUrl: "x", failedAt: Date.now() });

    showPanel();
    await until(() => win.panel && !win.panel.webContents.isLoading());
    await wait(1500);
    win.panel.webContents.send("panel:pending", 3); // what main sends on changes; boot() reads it from panel:init too
    await wait(200);
    r.bannerShown = await js(`!document.getElementById('pendingBanner').hidden`);
    r.bannerTitle = await js(`document.getElementById('pendingTitle').textContent`);
    r.bannerShot = await shot(win.panel, "panel-pending");

    const result = await retryFailedUploads({ manual: false });
    r.result = result;
    await wait(300);
    r.bannerHiddenAfter = await js(`document.getElementById('pendingBanner').hidden`);
    const after = await api.recent(10);
    const v = after.videos.find((x) => x.id === video.id);
    r.serverStatus = v?.status;
    r.serverDurationMs = v?.durationMs;
    r.remainingIds = library.pending().map((p) => p.id[0]);
    r.uploadedLedger = Object.keys(JSON.parse(fs.readFileSync(path.join(config.DIR, "uploaded.json"), "utf8"))).includes(video.id);
    // the uploaded file is the local copy, byte for byte
    const full = await fetch(`${api.serverUrl()}/api/videos/${video.id}`, { headers: { authorization: `Bearer ${config.token()}` } }).then((res) => res.json());
    const head = await fetch(full.videoUrl, { headers: { range: "bytes=0-0" } });
    r.remoteBytes = Number(head.headers.get("content-range")?.split("/")[1]);
    r.localBytes = fs.statSync(file).size;
    await api.deleteVideo(video.id).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    library.removePending("e".repeat(32));
    library.removePending("d".repeat(32));
    const ok = r.bannerShown && r.serverStatus === "ready" && r.serverDurationMs === 3210 && r.remainingIds.sort().join("") === "de" && r.uploadedLedger && r.remoteBytes === r.localBytes && result.done === 1;
    out({ ok, retry: r });
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
      if (mode === "retry") return await runRetry();
      if (mode === "quit") {
        // A normal quit (menu, ⌘Q, shutdown) must actually exit, also with the panel created and shown.
        showPanel();
        await until(() => win.panel && !win.panel.webContents.isLoading());
        await wait(800);
        app.once("will-quit", () => fs.writeFileSync(process.env.RECORDIUS_E2E_OUT || "/dev/stdout", JSON.stringify({ ok: true, quit: "exited" })));
        setTimeout(() => out({ ok: false, error: "app.quit() was blocked" }), 5000);
        return app.quit();
      }

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
