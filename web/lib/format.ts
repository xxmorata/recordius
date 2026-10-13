export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export function formatDurationWords(ms: number | null | undefined): string {
  if (ms == null) return "";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} sec`;
  const m = Math.round(total / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} hr ${m % 60} min`;
}

export function formatDate(ts: number | string | Date): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatRelative(ts: number | string | Date, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(ts).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} days ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)} weeks ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)} months ago`;
  return `${Math.floor(diff / 86400 / 365)} years ago`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Parses "90", "1m30s", "1h2m3s" or "1:30" into seconds. */
export function parseStartTime(raw: string | null): number | null {
  if (!raw) return null;
  const value = raw.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^\d+(:\d{1,2}){1,2}$/.test(value)) return value.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!m || !value) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function formatStartTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}h` : ""}${h || m ? `${m}m` : ""}${s % 60}s`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Returns an in-app path for a post-login redirect, or null. Resolves the value the way a browser
 * would (so `//evil`, `/\evil`, control characters etc. can't escape) and keeps only path+query+hash.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || /[\x00-\x1f\x7f\s]/.test(raw) || !/^\/(?![\/\\])/.test(raw)) return null;
  try {
    const u = new URL(raw, "http://recordius.invalid");
    if (u.origin !== "http://recordius.invalid" || !u.pathname.startsWith("/")) return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}
