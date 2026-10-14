const video = document.getElementById("v");
const err = document.getElementById("err");
let stream = null;
let currentDevice = null;
let releaseTimer = null;
let opening = null;
// Bumped by every release and every new open: a camera that finishes opening after that is closed right
// away, so a slow open (or several quick show/hide messages) can never leave the camera light on.
let gen = 0;

function release() {
  gen++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  currentDevice = null;
  pending = null;
  video.srcObject = null;
}

let pending = null; // { want, promise } while a camera is being opened
async function ensureStream(deviceId) {
  const want = deviceId || null;
  const live = stream?.getVideoTracks()[0];
  // "Default camera" and that same camera picked by id are the same device: don't reopen it.
  if (live?.readyState === "live" && (want === null || want === currentDevice || want === live.getSettings().deviceId)) return;
  if (pending?.want === want) return pending.promise; // already opening this one
  release();
  const mine = gen;
  const promise = (async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: want ? { exact: want } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      if (mine !== gen) return s.getTracks().forEach((t) => t.stop()); // hidden or switched meanwhile
      stream = s;
      currentDevice = want;
      video.srcObject = s;
      err.hidden = true;
      // Only report ready once a real frame is on screen, so the bubble never flashes black.
      await new Promise((resolve) => {
        if (video.readyState >= 2) return resolve();
        video.addEventListener("loadeddata", resolve, { once: true });
        setTimeout(resolve, 3000);
      });
    } catch (e) {
      if (mine !== gen) return;
      err.textContent = `Camera unavailable (${e.name})`;
      err.hidden = false;
    } finally {
      if (pending?.promise === promise) pending = null;
    }
  })();
  pending = { want, promise };
  return promise;
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
