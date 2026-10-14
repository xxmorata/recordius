// All of the app's HTTP goes through Chromium's network stack (Electron's net.fetch), like the browser:
// it follows the Mac's proxy / PAC settings and VPN apps, uses the macOS certificate store and falls back
// between IPv6 and IPv4. Node's own fetch (undici) ignores all of that, so on networks where the server is
// only reachable through a proxy the website worked but the app timed out (UND_ERR_CONNECT_TIMEOUT).
const { Readable } = require("node:stream");

let electronNet = null;
try {
  electronNet = require("electron").net ?? null; // plain Node (unit tests): "electron" is just a path string
} catch {}

function isNodeStream(body) {
  return body && typeof body === "object" && typeof body.pipe === "function" && typeof body.on === "function";
}

/** fetch() with the same API; requests made before the app is ready, or outside Electron, use Node's fetch. */
async function fetch(input, init = {}) {
  const { app } = electronNet ? require("electron") : {};
  if (!electronNet?.fetch || !app?.isReady()) return globalThis.fetch(input, init);
  const opts = { ...init };
  delete opts.dispatcher; // undici-only
  if (isNodeStream(opts.body)) opts.body = Readable.toWeb(opts.body);
  if (opts.body instanceof ReadableStream) opts.duplex = "half";
  // API answers and update checks must never come from the HTTP cache.
  if (!opts.cache) opts.cache = "no-store";
  try {
    return await electronNet.fetch(input, opts);
  } catch (err) {
    // Same shape as Node's fetch errors ("fetch failed" + cause.code), so callers and @vercel/blob's retries work.
    const code = /net::(ERR_[A-Z_]+)/.exec(err?.message ?? "")?.[1] ?? err?.code ?? "NETWORK_ERROR";
    throw Object.assign(new TypeError("fetch failed"), { cause: { code, message: err?.message } });
  }
}

/** @vercel/blob calls require("undici").fetch at request time: point it at the same network stack. */
function useForVercelBlob() {
  try {
    require("undici").fetch = fetch;
  } catch {}
}

/** "Can't reach …" message with a hint people can act on. */
function unreachable(what, err) {
  const code = err?.cause?.code ?? err?.code ?? err?.message ?? "network error";
  const offline = /INTERNET_DISCONNECTED|ENOTFOUND|NAME_NOT_RESOLVED|EAI_AGAIN/.test(code);
  const hint = offline ? "check your internet connection" : "check your internet connection, VPN or proxy";
  return `Can't reach ${what} — ${hint} (${code})`;
}

module.exports = { fetch, useForVercelBlob, unreachable };
