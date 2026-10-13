const config = require("./config");

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(method, route, body, { server, token } = {}) {
  const base = (server ?? config.load().server)?.replace(/\/$/, "");
  const bearer = token ?? config.token();
  if (!base || !bearer) throw new ApiError(401, "Not connected to a workspace");
  let res;
  try {
    res = await fetch(`${base}${route}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "user-agent": "Recordius-desktop" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, `Can't reach ${base} (${err.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `${method} ${route} failed (${res.status})`);
  return data;
}

module.exports = {
  ApiError,
  /** Verifies a token against a server; used when connecting. */
  me: (opts) => call("GET", "/api/me", undefined, opts),
  /** Loom's startNewRecordingSession: {id, title, privacy, shareUrl, upload:{videoPathname, videoToken, thumbPathname, thumbToken, access}} */
  createVideo: (title, mimeType) => call("POST", "/api/videos", { title, mimeType }),
  /** Loom's CompleteVideo */
  completeVideo: (id, durationMs, size) => call("POST", `/api/videos/${id}/complete`, { durationMs, size }),
  markThumbnail: (id) => call("POST", `/api/videos/${id}/thumbnail`),
  deleteVideo: (id) => call("DELETE", `/api/videos/${id}`),
  recent: (limit = 4) => call("GET", `/api/videos?scope=mine&limit=${limit}`),
  serverUrl: () => config.load().server?.replace(/\/$/, "") ?? null,
};
