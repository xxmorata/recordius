// Drives the app for automated testing. Loaded only when RECORDIUS_E2E is set.
//   RECORDIUS_E2E=<mode>:<ms>       mode: cam | screen | screen-cam | ui | signin | update | retry
//   RECORDIUS_E2E_FAKE=1            Chromium's fake camera/microphone (no OS permissions needed)
//   RECORDIUS_E2E_CONNECT="<server> <token>"   connect before recording (otherwise the stored token is used)
//   RECORDIUS_E2E_OPTS=<json>       extra recording settings
//   RECORDIUS_E2E_OUT=<file>        where to write the JSON result
//   RECORDIUS_E2E_SHOTS=<dir>       save screenshots of the app's windows
//   RECORDIUS_E2E_PROBE=<binary>    (devices mode) prints {"mic":bool,"camera":bool}: is any mic/camera in use on this Mac
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

module.exports = ({ startRecording, stopRecording, cancelRecording, togglePause, showPanel, hidePanel, connect, win, getState, getRec, retryFailedUploads, handleDeepLink, startConnect }) => {
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

  // Every camera/mic track any window opens, so a test can tell which ones are still live (= the macOS dot is on).
  app.on("web-contents-created", (_e, wc) =>
    wc.on("dom-ready", () =>
      wc
        .executeJavaScript(
          `(() => { if (window.__liveTracks) return; window.__liveTracks = []; const md = navigator.mediaDevices; if (!md) return;
            for (const fn of ["getUserMedia", "getDisplayMedia"]) { const orig = md[fn].bind(md);
              md[fn] = async (c) => { const s = await orig(c); for (const t of s.getTracks()) window.__liveTracks.push(t); return s; }; } })()`,
        )
        .catch(() => {}),
    ),
  );

  /** Mic and camera are released whenever Recordius isn't showing them: panel hidden, unfocused, minimized, after recording. */
  const runDevices = async () => {
    const { execFileSync } = require("node:child_process");
    const liveIn = async (w) =>
      !w || w.isDestroyed() ? [] : w.webContents.executeJavaScript(`(window.__liveTracks || []).filter((t) => t.readyState === "live").map((t) => t.kind)`).catch(() => []);
    const live = async () => {
      const r = {};
      for (const name of ["panel", "camera", "recorder"]) {
        const kinds = await liveIn(win[name]);
        if (kinds.length) r[name] = kinds;
      }
      return r;
    };
    const os = () => (process.env.RECORDIUS_E2E_PROBE ? JSON.parse(execFileSync(process.env.RECORDIUS_E2E_PROBE, { encoding: "utf8" })) : null);
    const r = { steps: [] };
    const check = async (step, expectOff) => {
      const tracks = await live();
      const entry = { step, tracks, os: os() };
      entry.ok = !expectOff || (Object.keys(tracks).length === 0 && (!entry.os || (!entry.os.mic && !entry.os.camera)));
      r.steps.push(entry);
    };
    const settle = () => wait(5500); // the camera bubble keeps its camera 4 s after hiding, so toggling is instant

    showPanel();
    await until(() => win.panel && !win.panel.webContents.isLoading());
    for (let t = 0; t < 100 && !(await win.panel.webContents.executeJavaScript("warmed")); t++) await wait(200);
    await wait(1500);
    await check("panel open", false);
    // The panel gets "shown" from several places at once (show, focus, the direct message): no extra streams.
    showPanel();
    win.panel.emit("focus");
    showPanel();
    win.panel.emit("focus");
    await wait(2500);
    await check("panel re-shown 4×", false);
    hidePanel();
    await settle();
    await check("panel closed (Esc / ⌘W)", true);

    showPanel();
    await wait(3000);
    // Another app in front: focus a window that isn't the panel (tests run without being the frontmost app).
    const other = new (require("electron").BrowserWindow)({ width: 200, height: 200, show: false });
    other.show();
    other.focus();
    win.panel.blur();
    win.panel.emit("blur");
    await settle();
    await check("panel behind another app", true);
    other.destroy();
    win.panel.focus();
    win.panel.emit("focus");
    await wait(3000);
    await check("panel focused again", false);
    win.panel.minimize();
    win.panel.emit("blur");
    await settle();
    await check("panel minimized", true);
    win.panel.restore();
    hidePanel();
    await settle();

    // A recording with camera and mic: everything is released once it's over.
    startRecording({ source: "camera", cameraId: null, micId: null, systemAudio: false, countdown: false });
    if ((await until(() => getState() === "recording", 30000)) === null) throw new Error(`recording did not start (state=${getState()})`);
    await wait(3000);
    await check("recording", false);
    await stopRecording();
    await settle();
    await check("after a recording", true);

    // Cancelled while the recorder is still opening the devices.
    startRecording({ source: "camera", cameraId: null, micId: null, systemAudio: false, countdown: false });
    await until(() => getState() === "preparing", 5000);
    await wait(50);
    await cancelRecording();
    await settle();
    await wait(4000);
    await check("cancelled while starting", true);

    r.ok = r.steps.every((s) => s.ok);
    out({ ok: r.ok, devices: r });
  };

  const runUi = async () => {
    const js = (code) => win.panel.webContents.executeJavaScript(code);
    // Clicks by selector and names the selector when the element isn't there.
    const click = async (selector) => {
      const found = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return Boolean(el); })()`);
      if (!found) {
        const state = await js(`JSON.stringify({ view: document.body.dataset.view, warmed, warming: Boolean(warming), media: init && init.media, cameras: devices.cameras.length, mics: devices.mics.length })`);
        throw new Error(`panel element not found: ${selector} ${state}`);
      }
    };
    const camVisible = () => Boolean(win.camera && !win.camera.isDestroyed() && win.camera.isVisible());
    const r = {};
    showPanel();
    await until(() => win.panel && !win.panel.webContents.isLoading());
    await wait(2500);
    r.view = await js(`document.body.dataset.view`);
    r.panelShot = await shot(win.panel, "panel");
    // open each row (accordion) and screenshot
    await click('[data-row="source"] .row-head');
    await wait(900);
    r.sourceOpen = await shot(win.panel, "panel-source-open");
    r.screenCount = await js(`document.querySelectorAll('[data-screen]').length`);
    r.windowCount = await js(`document.querySelectorAll('[data-window]').length`);
    await click('[data-row="source"] .row-head');
    // The device list appears once macOS has answered the camera/mic permission question.
    for (let t = 0; t < 150 && !(await js(`Boolean(document.querySelector('[data-camera]'))`)); t++) await wait(200);
    await click('[data-row="camera"] .row-head');
    await wait(600);
    r.cameraOpen = await shot(win.panel, "panel-camera-open");
    r.cameraCount = await js(`document.querySelectorAll('[data-camera]').length`);
    r.cameraVisibleWhileIdle = camVisible();
    await click('[data-camera="none"]');
    r.cameraHiddenAfterOff = await until(() => !camVisible(), 3000);
    await click('[data-camera]:not([data-camera="none"])');
    r.cameraShownAgainMs = await until(camVisible, 8000);
    await click('[data-row="camera"] .row-head');
    await click('[data-row="mic"] .row-head');
    await wait(600);
    r.micOpen = await shot(win.panel, "panel-mic-open");
    r.micCount = await js(`document.querySelectorAll('[data-mic]').length`);
    await click('[data-row="mic"] .row-head');
    await click('#openSettings');
    await wait(500);
    r.settingsShot = await shot(win.panel, "panel-settings");
    r.settingsView = await js(`document.body.dataset.view`);
    await click('#settingsBack');
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
    const ok = r.bannerShown && r.serverStatus === "ready" && r.serverDurationMs === 3210 && r.remainingIds.sort().join("") === "de" && r.uploadedLedger && r.remoteBytes === r.localBytes;
    out({ ok, retry: r });
  };

  // RECORDIUS_E2E_SOURCE=screen records the real screen (needs Screen Recording permission); default: camera.
  const testPlan = async () => {
    if (process.env.RECORDIUS_E2E_SOURCE !== "screen") return { source: "camera", sourceId: null, cameraId: null, micId: null, systemAudio: false, countdown: false };
    const [screen] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    return { source: "screen", sourceId: screen?.id ?? null, cameraId: "none", micId: "none", systemAudio: false, countdown: false };
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
      if (mode === "devices") return await runDevices();
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
      if (mode === "quit-recording") {
        // ⌘Q while recording: the recording must be complete on disk and queued for the next start.
        const library = require("./library");
        startRecording(await testPlan());
        if ((await until(() => getState() === "recording", 30000)) === null) throw new Error(`recording did not start (state=${getState()})`);
        const rec = getRec();
        await wait(5000);
        app.once("will-quit", () => {
          const entry = library.pending().find((p) => p.id === rec.video.id);
          const size = fs.existsSync(rec.localPath) ? fs.statSync(rec.localPath).size : 0;
          fs.writeFileSync(process.env.RECORDIUS_E2E_OUT, JSON.stringify({ ok: Boolean(entry && size > 0 && entry.durationMs > 3000), id: rec.video.id, queued: Boolean(entry), durationMs: entry?.durationMs, size, localPath: rec.localPath }));
        });
        app.quit();
        return;
      }
      if (mode === "source-ended" || mode === "recorder-crash") {
        // What's being recorded goes away (window closed, display unplugged) — or the capture process dies:
        // the app must stop by itself, upload what it has and be ready to record again.
        const api = require("./api");
        startRecording(await testPlan());
        if ((await until(() => getState() === "recording", 30000)) === null) throw new Error(`recording did not start (state=${getState()})`);
        const rec = getRec();
        await wait(mode === "recorder-crash" ? 12000 : 4000); // the MP4 muxer hands over data every few seconds
        if (mode === "source-ended") await win.recorder.webContents.executeJavaScript(`window.__videoForThumb.getVideoTracks().forEach((t) => t.dispatchEvent(new Event("ended")))`);
        else win.recorder.webContents.forcefullyCrashRenderer();
        const back = await until(() => getState() === "idle", 60000);
        await wait(3000);
        const video = (await api.recent(5)).videos.find((v) => v.id === rec.video.id);
        const againPlan = await testPlan();
        const again = await new Promise((resolve) => {
          startRecording(againPlan);
          until(() => getState() === "recording", 30000).then((t) => resolve(t !== null));
        });
        if (again) {
          await wait(2000);
          await stopRecording();
        }
        return out({ ok: back !== null && video?.status === "ready" && again, idleAfterMs: back, status: video?.status, size: video?.size ?? null, canRecordAgain: again, localPath: rec.localPath });
      }
      if (mode === "deeplink") {
        // A website opening recordius:// links must not be able to connect the app or start recording.
        const config = require("./config");
        const { dialog } = require("electron");
        const [server, token] = process.env.RECORDIUS_E2E_LINK.split(/\s+/);
        const asked = [];
        dialog.showMessageBox = async (opts) => (asked.push(opts.message), { response: 0 }); // the user clicks Cancel
        const before = config.token();
        handleDeepLink(`recordius://connect?server=${encodeURIComponent(server)}&token=${token}`);
        await wait(1500);
        const r = { dialogShown: asked.length === 1, dialogText: asked[0] ?? null, tokenUnchanged: config.token() === before };
        handleDeepLink(`recordius://connect?server=${encodeURIComponent(server)}&token=${token}&state=wrong`);
        await wait(800);
        r.wrongStateAsks = asked.length === 2 && config.token() === before;
        handleDeepLink("recordius://record");
        await wait(1500);
        r.recordLinkIgnored = getState() === "idle";
        const state = startConnect(server); // what "Continue in browser" does
        handleDeepLink(`recordius://connect?server=${encodeURIComponent("https://other.example")}&token=${token}&state=${state}`);
        await wait(800);
        r.stateForOtherServerAsks = asked.length === 3 && config.token() === before;
        handleDeepLink(`recordius://connect?server=${encodeURIComponent(server)}&token=${token}&state=${state}`);
        await until(() => config.token() === token, 8000);
        r.matchingStateConnects = config.token() === token && asked.length === 3;
        return out({ ok: Object.values(r).every((v) => v !== false), deeplink: r });
      }
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
      // The tallest layout (screen + camera recordings also show the camera toggle) must fit too.
      await win.controls.webContents.executeJavaScript(`for (const id of ["camera", "cameraSep"]) document.getElementById(id).hidden = false`);
      await wait(400);
      shots.controlsWithCamera = await shot(win.controls, "controls-with-camera");
      shots.controlsBounds = win.controls.getContentBounds();
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
