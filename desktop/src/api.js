const config = require("./config");
const http = require("./http");

class ApiError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code; // machine-readable reason from the server, when it sends one
  }
}

async function call(method, route, body, { server, token } = {}) {
  const base = (server ?? config.load().server)?.replace(/\/$/, "");
  const bearer = token ?? config.token();
  if (!base || !bearer) throw new ApiError(401, "Not connected to a workspace");
  let res;
  const send = () =>
    http.fetch(`${base}${route}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "user-agent": "Recordius-desktop" },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    try {
      res = await send();
    } catch (err) {
      // A kept-alive connection the server closed at the same moment fails before the request reaches it
      // (browsers retry this by themselves); one immediate retry on a fresh connection fixes it.
      if (!isStaleConnection(err)) throw err;
      res = await send();
    }
  } catch (err) {
    throw new ApiError(0, http.unreachable(base, err));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `${method} ${route} failed (${res.status})`, data.code ?? null);
  return data;
}

function isStaleConnection(err) {
  const code = err?.cause?.code ?? err?.code;
  return ["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_EMPTY_RESPONSE"].includes(code);
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
  /** Fresh upload tokens to retry an unfinished upload (code "video_gone": deleted, "already_uploaded": done). */
  uploadToken: (id) => call("POST", `/api/videos/${id}/upload-token`),
  /** Signed upload URLs for servers that store files in S3-compatible or local storage. */
  upload: (id, body) => call("POST", `/api/videos/${id}/upload`, body),
  recent: (limit = 4) => call("GET", `/api/videos?scope=mine&limit=${limit}`),
  serverUrl: () => config.load().server?.replace(/\/$/, "") ?? null,
};
