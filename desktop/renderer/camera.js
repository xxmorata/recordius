const video = document.getElementById("v");
const err = document.getElementById("err");
let stream = null;
let currentDevice = null;
let releaseTimer = null;
let opening = null;

function release() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  currentDevice = null;
  video.srcObject = null;
}

async function ensureStream(deviceId) {
  const want = deviceId || null;
  const live = stream?.getVideoTracks()[0];
  // "Default camera" and that same camera picked by id are the same device: don't reopen it.
  if (live?.readyState === "live" && (want === null || want === currentDevice || want === live.getSettings().deviceId)) return;
  release();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { deviceId: want ? { exact: want } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    currentDevice = want;
    video.srcObject = stream;
    err.hidden = true;
    // Only report ready once a real frame is on screen, so the bubble never flashes black.
    await new Promise((resolve) => {
      if (video.readyState >= 2) return resolve();
      video.addEventListener("loadeddata", resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  } catch (e) {
    err.textContent = `Camera unavailable (${e.name})`;
    err.hidden = false;
  }
}

window.recordius.on("camera:show", async ({ deviceId, mirror }) => {
  clearTimeout(releaseTimer);
  setMirror(mirror);
  const run = (opening = ensureStream(deviceId));
  await run;
  if (opening === run) window.recordius.send("camera:ready");
});

window.recordius.on("camera:hide", () => {
  // Keep the camera warm briefly so toggling is instant, then release it so the camera light turns off.
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(release, 4000);
});

function setMirror(mirror) {
  video.style.transform = mirror === false ? "none" : "scaleX(-1)";
}
window.recordius.on("camera:mirror", setMirror);

for (const b of document.querySelectorAll("[data-size]")) b.onclick = () => window.recordius.send("camera:size", b.dataset.size);
