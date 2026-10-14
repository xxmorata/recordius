// Hidden window that owns the capture streams and the MediaRecorder (Loom: recorder.html + native helper).

const TIMESLICE_MS = 1000;
// Bounding box per quality setting (aspect ratio is preserved by the capturer).
const QUALITY = {
  720: { width: 1280, height: 800 },
  1080: { width: 1920, height: 1200 },
  1440: { width: 2560, height: 1600 },
};
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640033,mp4a.40.2",
  "video/mp4;codecs=avc1,opus",
  "video/mp4",
  "video/webm;codecs=h264,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm",
];

let streams = [];
let recorder = null;
let audioCtx = null;
let discard = false;
let chunkChain = Promise.resolve();

function pickMimeType() {
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm";
}

function track(stream) {
  streams.push(stream);
  return stream;
}

function stopStreams() {
  for (const s of streams) for (const t of s.getTracks()) t.stop();
  streams = [];
  audioCtx?.close();
  audioCtx = null;
}

async function screenStream(sourceId, box) {
  // chromeMediaSource works without a user gesture, which a hidden window never has.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxWidth: box.width,
        maxHeight: box.height,
        maxFrameRate: 30,
      },
    },
  });
  return track(stream);
}

async function systemAudioStream() {
  // The main process answers getDisplayMedia with {audio: "loopback"}; we only keep the audio.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!stream.getAudioTracks().length) throw new Error("no system audio track");
  return track(stream);
}

async function cameraStream(deviceId, box) {
  return track(
    await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: box.width },
        height: { ideal: Math.round((box.width * 9) / 16) },
        frameRate: { ideal: 30 },
      },
    }),
  );
}

/**
 * Horizontally flips a video track frame by frame (insertable streams), so "Cam only" recordings
 * match the mirrored preview. Falls back to the original track if the APIs are unavailable.
 */
function mirrorStream(stream) {
  const [input] = stream.getVideoTracks();
  if (typeof MediaStreamTrackProcessor !== "function") return stream;
  const { width = 1280, height = 720, frameRate = 30 } = input.getSettings();
  // Frames are pulled by the processor (not requestAnimationFrame, which never runs in this
  // hidden window) and drawn flipped onto a canvas whose capture stream is what we record.
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  const output = canvas.captureStream(frameRate);
  const processor = new MediaStreamTrackProcessor({ track: input });
  processor.readable
    .pipeTo(
      new WritableStream({
        write(frame) {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          frame.close();
        },
      }),
    )
    .catch(() => {});
  return track(output);
}

async function micStream(deviceId) {
  return track(
    await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }),
  );
}

/** Mixes any number of audio tracks into one (mic + system audio). */
function mixAudio(audioStreams) {
  if (audioStreams.length <= 1) return audioStreams[0]?.getAudioTracks() ?? [];
  audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  for (const s of audioStreams) audioCtx.createMediaStreamSource(s).connect(dest);
  return dest.stream.getAudioTracks();
}

async function prepare(settings) {
  discard = false;
  stopStreams();
  const warnings = [];

  const box = QUALITY[settings.quality] ?? QUALITY[1080];
  let video = settings.mode === "cam" ? await cameraStream(settings.cameraId, box) : await screenStream(settings.sourceId, box);
  if (settings.mode === "cam" && settings.mirrorCamera !== false) video = mirrorStream(video);
  const audio = [];
  if (settings.micId !== "none") {
    try {
      audio.push(await micStream(settings.micId));
    } catch (err) {
      warnings.push(`Microphone unavailable (${err.name}); recording without it.`);
    }
  }
  if (settings.systemAudio && settings.mode !== "cam") {
    try {
      audio.push(await systemAudioStream());
    } catch (err) {
      warnings.push(`System audio unavailable on this Mac (${err.name}).`);
    }
  }

  const combined = new MediaStream([...video.getVideoTracks(), ...mixAudio(audio)]);
  const mimeType = pickMimeType();
  const { width = 1920, height = 1080 } = video.getVideoTracks()[0].getSettings();
  const pixels = width * height;
  recorder = new MediaRecorder(combined, {
    mimeType,
    // ~5 Mbps at 1080p; screen content compresses well so this stays crisp for text.
    videoBitsPerSecond: Math.round(Math.min(8e6, Math.max(2.5e6, (pixels / (1920 * 1080)) * 5e6))),
    audioBitsPerSecond: 128000,
  });

  recorder.ondataavailable = (e) => {
    if (discard || !e.data.size) return;
    // Keep chunks strictly ordered: arrayBuffer() is async. One failed chunk must never break the chain
    // (that would drop every later chunk and the "stopped" message).
    chunkChain = chunkChain.then(async () => window.recordius.send("rec:chunk", await e.data.arrayBuffer())).catch(() => {});
  };
  recorder.onerror = (e) => window.recordius.send("rec:failed", e.error?.message ?? "the recorder stopped unexpectedly");
  // The recorded window was closed, or the display unplugged: stop cleanly and keep what's there.
  for (const t of combined.getVideoTracks()) t.addEventListener("ended", () => recorder?.state !== "inactive" && window.recordius.send("rec:source-ended"));
  recorder.onstop = () => {
    chunkChain.then(() => {
      stopStreams();
      if (!discard) window.recordius.send("rec:stopped");
    });
  };

  window.__videoForThumb = video;
  return { mimeType, width, height, warning: warnings.join(" ") || null };
}

async function captureThumbnail(stream) {
  const [t] = stream.getVideoTracks();
  if (!t || t.readyState !== "live") return;
  const el = document.createElement("video");
  el.muted = true;
  el.srcObject = new MediaStream([t.clone()]);
  await el.play();
  await new Promise((r) => setTimeout(r, 300));
  const scale = Math.min(1, 1280 / el.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(el.videoWidth * scale);
  canvas.height = Math.round(el.videoHeight * scale);
  canvas.getContext("2d").drawImage(el, 0, 0, canvas.width, canvas.height);
  el.srcObject.getTracks().forEach((x) => x.stop());
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
  if (blob) window.recordius.send("rec:thumbnail", await blob.arrayBuffer());
}

window.recordius.on("rec:prepare", async (settings) => {
  try {
    window.recordius.send("rec:prepared", await prepare(settings));
  } catch (err) {
    stopStreams();
    const hint = err.name === "NotAllowedError" || err.name === "NotReadableError" ? " Check Screen Recording / Camera permissions in System Settings." : "";
    window.recordius.send("rec:error", `${err.name}: ${err.message}.${hint}`);
  }
});

window.recordius.on("rec:start", () => {
  chunkChain = Promise.resolve();
  try {
    recorder.start(TIMESLICE_MS);
  } catch (err) {
    stopStreams();
    window.recordius.send("rec:error", `${err.name}: ${err.message}`);
    return;
  }
  window.recordius.send("rec:started");
  setTimeout(() => captureThumbnail(window.__videoForThumb).catch(() => {}), 1200);
});

window.recordius.on("rec:pause", () => recorder?.state === "recording" && recorder.pause());
window.recordius.on("rec:resume", () => recorder?.state === "paused" && recorder.resume());
window.recordius.on("rec:stop", () => {
  if (recorder && recorder.state !== "inactive") recorder.stop();
  else window.recordius.send("rec:stopped");
});
window.recordius.on("rec:discard", () => {
  discard = true;
  if (recorder && recorder.state !== "inactive") recorder.stop();
  else stopStreams();
});
