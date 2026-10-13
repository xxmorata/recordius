const $ = (id) => document.getElementById(id);

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

window.recordius.on("controls:state", ({ state, elapsedMs }) => {
  $("time").textContent = fmt(elapsedMs);
  const paused = state === "paused";
  $("bar").classList.toggle("paused", paused);
  $("pauseIcon").style.display = paused ? "none" : "";
  $("playIcon").style.display = paused ? "" : "none";
  $("pause").title = paused ? "Resume (⌘⇧P)" : "Pause (⌘⇧P)";
});

async function refreshCamera() {
  const s = await window.recordius.invoke("controls:camera-state");
  $("camera").hidden = !s.hasCamera;
  $("camera").classList.toggle("off", !s.visible);
}

$("stop").onclick = () => window.recordius.send("controls:stop");
$("pause").onclick = () => window.recordius.send("controls:pause");
$("restart").onclick = () => window.recordius.send("controls:restart");
$("cancel").onclick = () => confirm("Delete this recording?") && window.recordius.send("controls:cancel");
$("camera").onclick = async () => {
  window.recordius.send("controls:camera");
  setTimeout(refreshCamera, 300);
};
refreshCamera();
