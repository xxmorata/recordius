const $ = (id) => document.getElementById(id);
const api = window.recordius;

let init = null; // panel:init payload
let settings = {}; // recorder choices (mirrors config)
let sources = { screens: [], windows: [] };
let devices = { cameras: [], mics: [] };
let sourcesLoadedAt = 0;
let panelInFront = false; // shown and focused: only then may the panel use the camera and microphone

const CHECK = `<svg class="check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4 4 8-8" /></svg>`;

// ───────── views ─────────

function setView(view) {
  document.body.dataset.view = view;
  if (view === "settings") fillSettings();
  if (view === "recorder" && warmed) {
    loadSources().catch(() => {});
    startMeter();
  } else stopMeter();
  updateCameraPreview();
}

function save(patch) {
  Object.assign(settings, patch);
  api.send("panel:settings", patch);
}

// ───────── recorder: labels & validation ─────────

function sourceName() {
  if (settings.source === "camera") return { main: "Camera only", sub: "Record just your camera" };
  const screen = sources.screens.find((s) => s.id === settings.sourceId);
  if (screen) return { main: screen.name, sub: screen.size ? `${screen.size}` : "" };
  const w = sources.windows.find((s) => s.id === settings.sourceId);
  if (w) return { main: w.name, sub: "Window" };
  return sourcesLoadedAt ? { main: "Choose what to record", sub: "" } : { main: "Finding your screens…", sub: "" };
}

function render() {
  const s = sourceName();
  $("sourceLabel").innerHTML = `${esc(s.main)}${s.sub ? `<small>${esc(s.sub)}</small>` : ""}`;

  const camOff = settings.cameraId === "none";
  const cam = devices.cameras.find((d) => d.deviceId === settings.cameraId) ?? devices.cameras[0];
  $("cameraLabel").textContent = camOff ? "No camera" : (cam?.label ?? "Camera");
  $("cameraBadge").textContent = camOff ? "Off" : "On";
  $("cameraBadge").className = `badge ${camOff ? "off" : "on"}`;
  $("mirrorCamera").checked = settings.mirrorCamera !== false;

  const micOff = settings.micId === "none";
  const mic = devices.mics.find((d) => d.deviceId === settings.micId) ?? devices.mics[0];
  $("micLabel").textContent = micOff ? "No microphone" : (mic?.label ?? "Microphone");
  $("micBadge").textContent = micOff ? "Off" : "On";
  $("micBadge").className = `badge ${micOff ? "off" : "on"}`;
  $("systemAudio").checked = Boolean(settings.systemAudio);
  $("sysAudioRow").hidden = settings.source === "camera";

  for (const el of document.querySelectorAll("[data-screen],[data-window]")) el.setAttribute("aria-pressed", String(settings.source !== "camera" && (el.dataset.screen ?? el.dataset.window) === settings.sourceId));
  $("cameraOnly").setAttribute("aria-pressed", String(settings.source === "camera"));
  for (const el of document.querySelectorAll("[data-camera]")) el.setAttribute("aria-pressed", String(el.dataset.camera === (camOff ? "none" : (cam?.deviceId ?? ""))));
  for (const el of document.querySelectorAll("[data-mic]")) el.setAttribute("aria-pressed", String(el.dataset.mic === (micOff ? "none" : (mic?.deviceId ?? ""))));

  let reason = "";
  if (settings.source !== "camera" && !settings.sourceId) reason = "Pick a screen or window to record.";
  else if (settings.source === "camera" && (camOff || !devices.cameras.length)) reason = devices.cameras.length ? "Turn the camera on to record camera only." : "No camera found.";
  $("start").disabled = Boolean(reason);
  $("hint").textContent = reason || "Your link is copied the moment you stop";
  $("hint").className = `hint${reason ? " warn" : ""}`;
  updateCameraPreview();
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

let lastPreview = "";
function updateCameraPreview(force = false) {
  const enabled = panelInFront && document.body.dataset.view === "recorder" && settings.cameraId !== "none" && (devices.cameras.length > 0 || init?.media.camera === "granted");
  const payload = { enabled, cameraId: settings.cameraId === "none" ? null : settings.cameraId };
  const key = JSON.stringify(payload);
  if (!force && key === lastPreview) return; // render() runs often; only talk to the main process on change
  lastPreview = key;
  api.send("panel:camera-preview", payload);
}

// ───────── accordion rows ─────────

function toggleRow(name) {
  for (const row of document.querySelectorAll(".row")) {
    const open = row.dataset.row === name && row.dataset.open !== "true";
    row.dataset.open = String(open);
  }
}
for (const name of ["source", "camera", "mic"]) document.querySelector(`[data-row="${name}"] .row-head`).onclick = () => toggleRow(name);

// ───────── sources ─────────

// "screen-permission": Recordius isn't allowed yet (macOS needs a restart of the app once it is).
// "screen-blocked": allowed, but macOS isn't handing out the screen right now — usually a pending
// system question, or a permission entry that needs to be switched off and on again.
let screenIssue = null;
function showScreenIssue(error) {
  screenIssue = error ? (error === "screen-blocked" ? "screen-blocked" : "screen-permission") : null;
  $("screenPerm").hidden = !screenIssue;
  if (!screenIssue) return;
  $("screenPermText").innerHTML =
    screenIssue === "screen-blocked"
      ? "<b>macOS isn’t sharing your screen yet</b>Look for a macOS prompt asking to allow Recordius, or switch Recordius off and on in System Settings → Screen &amp; System Audio Recording."
      : "<b>Screen recording is off</b>Turn on Recordius in System Settings — the app restarts itself.";
}

async function loadSources(force = false) {
  if (!force && Date.now() - sourcesLoadedAt < 3000) return;
  const res = await api.invoke("panel:sources");
  sourcesLoadedAt = Date.now();
  showScreenIssue(res.error);
  sources = { screens: res.screens, windows: res.windows };
  const box = $("screens");
  box.classList.toggle("multi", res.screens.length > 1);
  box.replaceChildren(
    ...res.screens.map((s) => {
      const b = document.createElement("button");
      b.className = "screen";
      b.dataset.screen = s.id;
      b.innerHTML = `<span class="thumb" style="background-image:url('${s.thumbnail}')"></span><span class="name">${esc(s.name)}${s.size ? `<small>${esc(s.size)}</small>` : ""}</span>`;
      b.onclick = () => {
        save({ source: "screen", sourceId: s.id });
        render();
        toggleRow(null);
      };
      return b;
    }),
  );
  $("windows").replaceChildren(
    ...res.windows.map((w) => {
      const b = document.createElement("button");
      b.className = "opt";
      b.dataset.window = w.id;
      b.title = w.name;
      b.innerHTML = `${w.icon ? `<img src="${w.icon}" alt="">` : `<span class="dot"></span>`}<span>${esc(w.name)}</span>${CHECK}`;
      b.onclick = () => {
        save({ source: "window", sourceId: w.id });
        render();
        toggleRow(null);
      };
      return b;
    }),
  );
  if (!res.windows.length) $("windows").innerHTML = `<p style="margin:4px 8px;color:var(--ink-4);font-size:12px">${res.error ? "Available once screen recording is allowed." : "No other windows open."}</p>`;
  const all = [...res.screens, ...res.windows];
  if (settings.source !== "camera" && !all.some((s) => s.id === settings.sourceId)) {
    settings.source = "screen";
    settings.sourceId = res.screens[0]?.id ?? null;
  }
  render();
}

$("cameraOnly").onclick = () => {
  save({ source: "camera" });
  if (settings.cameraId === "none") save({ cameraId: null });
  render();
  toggleRow(null);
};

// ───────── devices ─────────

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function loadDevices(media) {
  // While a macOS camera/mic question is unanswered the device list can stall; show what we have instead.
  let list = await withTimeout(navigator.mediaDevices.enumerateDevices(), 4000).catch(() => []);
  const unlabeled = (kind) => list.some((d) => d.kind === kind && !d.label);
  const audio = media.microphone === "granted" && unlabeled("audioinput");
  const video = media.camera === "granted" && unlabeled("videoinput");
  if (audio || video) {
    try {
      const s = await withTimeout(navigator.mediaDevices.getUserMedia({ audio, video }), 4000);
      s.getTracks().forEach((t) => t.stop());
      list = await withTimeout(navigator.mediaDevices.enumerateDevices(), 4000).catch(() => list);
    } catch {}
  }
  devices = {
    cameras: list.filter((d) => d.kind === "videoinput" && d.deviceId !== "default").map((d) => ({ deviceId: d.deviceId, label: d.label || "Camera" })),
    mics: list.filter((d) => d.kind === "audioinput" && d.deviceId !== "default").map((d) => ({ deviceId: d.deviceId, label: d.label || "Microphone" })),
  };
  const option = (kind, id, label, icon) => {
    const b = document.createElement("button");
    b.className = "opt";
    b.dataset[kind] = id;
    b.innerHTML = `${icon}<span>${esc(label)}</span>${CHECK}`;
    b.onclick = () => {
      save(kind === "camera" ? { cameraId: id } : { micId: id });
      render();
      if (kind === "mic") startMeter();
    };
    return b;
  };
  const camIcon = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="11" height="10" rx="2" /><path d="M13.5 9l4-2.5v7l-4-2.5" /></svg>`;
  const micIcon = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" /></svg>`;
  const off = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="7" /><path d="M5 15L15 5" /></svg>`;
  $("cameras").replaceChildren(...devices.cameras.map((d) => option("camera", d.deviceId, d.label, camIcon)), option("camera", "none", "No camera", off));
  $("mics").replaceChildren(...devices.mics.map((d) => option("mic", d.deviceId, d.label, micIcon)), option("mic", "none", "No microphone", off));
  // Resolve "default" (null) to the first device so the label is concrete, but keep "none".
  if (settings.cameraId !== "none" && !devices.cameras.some((d) => d.deviceId === settings.cameraId)) settings.cameraId = devices.cameras[0]?.deviceId ?? "none";
  if (settings.micId !== "none" && !devices.mics.some((d) => d.deviceId === settings.micId)) settings.micId = devices.mics[0]?.deviceId ?? "none";
}

// The level meter holds the microphone (macOS shows its orange dot), so it only runs while the panel is
// actually in front. Every start/stop bumps `gen`: a getUserMedia that resolves after a newer start or a
// stop releases its stream instead of keeping the mic open in the background.
const meter = { stream: null, ctx: null, raf: 0, gen: 0 };
function stopMeter() {
  meter.gen++;
  cancelAnimationFrame(meter.raf);
  meter.stream?.getTracks().forEach((t) => t.stop());
  meter.ctx?.close().catch(() => {});
  meter.stream = meter.ctx = null;
  $("level").style.width = "0";
}
async function startMeter() {
  stopMeter();
  const gen = meter.gen;
  const id = settings.micId;
  $("meter").hidden = !id || id === "none";
  if ($("meter").hidden || document.body.dataset.view !== "recorder" || !panelInFront) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } }, video: false });
    if (gen !== meter.gen || !panelInFront) return stream.getTracks().forEach((t) => t.stop());
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    Object.assign(meter, { stream, ctx });
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((a, v) => a + v * v, 0) / data.length);
      $("level").style.width = `${Math.min(100, Math.round(rms * 400))}%`;
      meter.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    if (gen === meter.gen) $("meter").hidden = true;
  }
}

// ───────── recent recordings ─────────

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function dur(ms) {
  if (ms == null) return "";
  const t = Math.round(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

let recentTimer = null;
async function loadRecent() {
  clearTimeout(recentTimer);
  let items = [];
  try {
    items = await api.invoke("panel:recent");
  } catch {
    $("recent").hidden = true;
    return;
  }
  $("recent").hidden = !items.length;
  $("recentList").replaceChildren(
    ...items.map((v) => {
      const row = document.createElement("div");
      row.className = "recent-item";
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.title = "Open in browser";
      const thumb = document.createElement("span");
      thumb.className = "rthumb";
      if (v.thumbUrl) thumb.style.backgroundImage = `url("${v.thumbUrl}")`;
      const meta = document.createElement("span");
      meta.className = "rmeta";
      const title = document.createElement("b");
      title.textContent = v.title;
      const sub = document.createElement("small");
      sub.textContent = v.status === "ready" ? `${dur(v.durationMs)} · ${ago(v.createdAt)}` : v.waiting ? "Saved on this Mac · will upload" : v.status === "failed" ? "Upload failed" : "Uploading…";
      meta.append(title, sub);
      const copy = document.createElement("button");
      copy.className = "copy";
      copy.textContent = "Copy link";
      copy.onclick = async (e) => {
        e.stopPropagation();
        await api.invoke("panel:copy", v.shareUrl);
        copy.textContent = "Copied";
        copy.classList.add("done");
        setTimeout(() => {
          copy.textContent = "Copy link";
          copy.classList.remove("done");
        }, 1400);
      };
      row.append(thumb, meta, copy);
      const open = () => api.send("panel:open-url", v.shareUrl);
      row.onclick = open;
      row.onkeydown = (e) => e.key === "Enter" && open();
      return row;
    }),
  );
  // Keep "Uploading…" rows fresh while the panel is open.
  if (items.some((v) => v.status === "recording" && !v.waiting) && !document.hidden) recentTimer = setTimeout(loadRecent, 3000);
}
api.on("panel:recent-changed", () => loadRecent());

// ───────── settings view ─────────

function fillSettings() {
  const a = init?.account;
  $("accountName").textContent = a?.name ?? "Not connected";
  $("accountWorkspace").textContent = a ? `${a.workspace} · ${a.email}` : "";
  const av = $("avatar");
  av.replaceChildren();
  if (a?.avatarUrl) {
    const img = document.createElement("img");
    img.src = a.avatarUrl;
    av.append(img);
  } else av.textContent = (a?.name ?? "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  $("sCountdown").checked = settings.countdown !== false;
  $("sMirror").checked = settings.mirrorCamera !== false;
  $("sQuality").value = String(settings.quality || "1080");
  $("sCameraSize").value = settings.cameraSize || "m";
  $("sKeepLocal").value = String(settings.keepLocalDays ?? 30);
  $("loginItemRow").hidden = !init?.packaged;
  $("sLoginItem").checked = Boolean(init?.loginItem);
  $("kbdToggle").textContent = init?.shortcuts.toggle ?? "⌘⇧R";
  $("kbdPause").textContent = init?.shortcuts.pause ?? "⌘⇧P";
  $("versionInline").textContent = `v${init?.version ?? ""}`;
  $("version").textContent = `Recordius ${init?.version ?? ""} · open source · ${init?.server ?? ""}`;
}
$("sCountdown").onchange = (e) => save({ countdown: e.target.checked });
$("sMirror").onchange = (e) => {
  save({ mirrorCamera: e.target.checked });
  $("mirrorCamera").checked = e.target.checked;
};
$("mirrorCamera").onchange = (e) => {
  save({ mirrorCamera: e.target.checked });
  $("sMirror").checked = e.target.checked;
};
$("systemAudio").onchange = (e) => save({ systemAudio: e.target.checked });
$("sQuality").onchange = (e) => save({ quality: e.target.value });
$("sCameraSize").onchange = (e) => save({ cameraSize: e.target.value });
$("sKeepLocal").onchange = (e) => save({ keepLocalDays: Number(e.target.value) });

// ───────── uploads that didn't finish ─────────

const PENDING_HINT = { 1: "It’s saved on this Mac. Recordius retries automatically.", n: "They’re saved on this Mac. Recordius retries automatically." };

function renderPending(count) {
  $("pendingBanner").hidden = !count;
  $("pendingTitle").textContent = count === 1 ? "1 upload didn’t finish" : `${count} uploads didn’t finish`;
  if (!$("retryUploads").disabled) $("pendingText").textContent = count === 1 ? PENDING_HINT[1] : PENDING_HINT.n;
}
api.on("panel:pending", (count) => {
  if (init) init.pendingUploads = count;
  renderPending(count);
});
$("retryUploads").onclick = async () => {
  const btn = $("retryUploads");
  btn.disabled = true;
  btn.textContent = "Uploading…";
  $("pendingText").textContent = "Uploading from the copy on this Mac…";
  try {
    const r = await api.invoke("panel:retry-uploads");
    btn.disabled = false;
    renderPending(r.remaining);
    if (r.error) $("pendingText").textContent = `Not uploaded yet: ${r.error}`;
  } catch {
    btn.disabled = false;
    renderPending(init?.pendingUploads ?? 0);
  } finally {
    btn.disabled = false;
    btn.textContent = "Retry now";
  }
};
$("sLoginItem").onchange = (e) => api.send("panel:login-item", e.target.checked);
$("openFolder").onclick = () => api.send("panel:recordings-folder");
$("signOut").onclick = () => {
  api.send("account:signout");
};

let pendingUpdate = null;
$("checkUpdates").onclick = async () => {
  $("checkUpdates").disabled = true;
  $("checkUpdates").textContent = "Checking…";
  try {
    const info = await api.invoke("update:check");
    pendingUpdate = info.available ? info : null;
    $("updateRow").hidden = !info.available;
    $("updateInfo").textContent = info.available ? `Version ${info.latest} is available (you have ${info.current}).` : "";
    $("checkUpdates").textContent = info.available ? "Update found" : "Up to date";
  } catch (err) {
    $("checkUpdates").textContent = "Check for updates";
    $("updateRow").hidden = false;
    $("updateInfo").textContent = `Couldn't check: ${err.message}`;
    $("installUpdate").hidden = true;
  } finally {
    $("checkUpdates").disabled = false;
  }
};
$("installUpdate").onclick = async () => {
  if (!pendingUpdate) return;
  $("installUpdate").disabled = true;
  $("installUpdate").textContent = "Downloading…";
  $("updateBar").hidden = false;
  try {
    await api.invoke("update:install", pendingUpdate);
  } catch (err) {
    $("installUpdate").disabled = false;
    $("installUpdate").textContent = "Update & restart";
    $("updateInfo").textContent = `Update failed: ${err.message}`;
  }
};
api.on("update:progress", (p) => ($("updateProgress").style.width = `${Math.round(p * 100)}%`));

// ───────── sign in ─────────

$("openConnect").onclick = async () => {
  $("signinError").textContent = "";
  try {
    const base = await api.invoke("account:open-connect", $("serverUrl").value);
    $("serverUrl").value = base;
    $("signinError").style.color = "var(--ink-3)";
    $("signinError").textContent = "Finish signing in in your browser, then click “Connect desktop app”.";
  } catch (err) {
    $("signinError").style.color = "";
    $("signinError").textContent = err.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
  }
};
$("serverUrl").addEventListener("keydown", (e) => e.key === "Enter" && $("openConnect").click());
$("toggleCode").onclick = () => {
  $("codeBox").hidden = !$("codeBox").hidden;
  if (!$("codeBox").hidden) $("code").focus();
};
$("submitCode").onclick = async () => {
  $("submitCode").disabled = true;
  $("signinError").textContent = "";
  try {
    await api.invoke("account:paste-code", $("code").value);
  } catch (err) {
    $("signinError").style.color = "";
    $("signinError").textContent = err.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
  } finally {
    $("submitCode").disabled = false;
  }
};

api.on("account:changed", async (info) => {
  init = { ...init, ...info };
  if (info.connected) {
    setView("recorder");
    await warmUp();
  } else {
    setView("signin");
    updateCameraPreview();
  }
});

// ───────── wiring ─────────

$("close").onclick = $("closeSignin").onclick = $("closeSettings").onclick = () => api.send("panel:close");
$("openSettings").onclick = () => setView("settings");
$("settingsBack").onclick = () => setView("recorder");
$("library").onclick = () => api.send("panel:library");
$("grantScreen").onclick = () => api.invoke("media:request", "screen");
$("relaunch").onclick = () => api.send("panel:relaunch");
$("start").onclick = () => {
  stopMeter();
  api.send("panel:start", {
    source: settings.source,
    sourceId: settings.sourceId,
    cameraId: settings.cameraId,
    micId: settings.micId,
    systemAudio: Boolean(settings.systemAudio),
  });
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.send("panel:close");
  if (e.key === "Enter" && document.body.dataset.view === "recorder" && !$("start").disabled && !["INPUT", "TEXTAREA"].includes(e.target.tagName)) $("start").click();
});
api.on("panel:navigate", (view) => setView(view));
let shownBeforeBoot = false; // the panel can be shown while boot() is still loading
api.on("panel:visibility", (visible) => {
  if (!init) {
    shownBeforeBoot = panelInFront = visible;
    return;
  }
  if (visible === panelInFront) return; // "show", "focus" and the direct message often arrive together
  panelInFront = visible;
  if (visible) {
    if (document.body.dataset.view === "recorder") {
      if (!warmed) warmUp();
      else {
        loadSources().catch(() => {});
        startMeter();
        updateCameraPreview(true);
        loadRecent();
      }
    }
  } else {
    stopMeter();
    lastPreview = ""; // the main process hid the bubble; the next render must ask for it again
  }
});
window.addEventListener("focus", () => document.body.dataset.view === "recorder" && loadSources().catch(() => {}));
new ResizeObserver(() => api.send("panel:resize", Math.ceil(document.body.scrollHeight))).observe(document.body);

// macOS applies a new Screen Recording permission only after a restart: watch for it and relaunch.
setInterval(async () => {
  if ($("screenPerm").hidden || screenIssue !== "screen-permission") return; // "blocked" is already granted: no restart loop
  if ((await api.invoke("media:status")) === "granted") {
    $("screenPermText").innerHTML = "<b>Permission granted.</b> Restarting Recordius…";
    setTimeout(() => api.send("panel:relaunch"), 800);
  }
}, 1500);

let warmed = false;
let warming = null;

/** Permission prompts, device list, screen previews and the mic meter — only once the panel is actually on screen. */
function warmUp() {
  if (warming) return warming;
  warming = (async () => {
    showScreenIssue(init.media.screen === "granted" ? null : "screen-permission");
    render();
    loadSources(true).catch(() => {});
    const media = { ...init.media };
    for (const kind of ["camera", "microphone"]) {
      // Ask once; but if the macOS prompt is left unanswered, list the devices anyway instead of waiting forever.
      if (media[kind] === "not-determined") {
        const answer = await Promise.race([api.invoke("media:request", kind), new Promise((r) => setTimeout(() => r(null), 10000))]);
        if (answer !== null) media[kind] = answer ? "granted" : "denied";
      }
    }
    init.media = media;
    await loadDevices(media).catch(() => {});
    warmed = true;
    render();
    startMeter();
    loadRecent();
  })().finally(() => (warming = null));
  return warming;
}

async function boot() {
  init = await api.invoke("panel:init");
  settings = { ...init.settings };
  if (!init.connected) {
    $("serverUrl").value = init.server ?? "";
    setView("signin");
    return;
  }
  setView("recorder");
  render();
  renderPending(init.pendingUploads);
  // Opened right at launch: the "shown" signal came before we were ready, so warm up now.
  if (shownBeforeBoot || init.visible) {
    panelInFront = true;
    warmUp();
  }
}
boot();
