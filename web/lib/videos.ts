import { sql } from "./db";
import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { customThumbPath, deleteFile, deletePrefix, downloadUrl, putPrivate, thumbPath, uploadTokens, videoPath, viewUrl } from "./blob";
import { HttpError, type CurrentUser } from "./auth";
import { VIDEO_ID_RE, hashPassword, isEmail, newVideoId, normalizeEmail, randomToken, verifyPassword } from "./ids";
import { authSecret } from "./env";

import { PRIVACY_LABELS, type Access, type LibraryScope, type Privacy, type Video, type VideoSource, type VideoStatus, type ViewerStats } from "./types";
export { PRIVACY_LABELS };
export type { Access, LibraryScope, Privacy, Video, VideoStatus };

/** Thrown when a link-shared video needs a password or its link has expired. */
export class LinkLockedError extends HttpError {
  constructor(public reason: "password" | "expired") {
    super(reason === "password" ? 401 : 410, reason === "password" ? "This video is password protected" : "This link has expired");
  }
}

type VideoRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  owner_name: string;
  owner_email: string;
  owner_avatar: string | null;
  title: string;
  status: VideoStatus;
  privacy: Privacy;
  secret: string;
  mime_type: string;
  ext: string;
  duration_ms: number | null;
  size_bytes: string | number | null;
  has_thumb: boolean;
  views: number;
  created_at: Date;
  completed_at: Date | null;
  archived_at: Date | null;
  trim_start_ms: number | null;
  trim_end_ms: number | null;
  link_password_hash: string | null;
  link_expires_at: Date | null;
  thumb_path: string | null;
  source: VideoSource;
};

const VIDEO_SELECT = `
  select v.*, u.name as owner_name, u.email as owner_email, u.avatar_path as owner_avatar
  from videos v join users u on u.id = v.owner_id`;

async function toVideo(row: VideoRow, withUrls: boolean, canDownloadFull = true): Promise<Video> {
  const ready = row.status === "ready";
  const [videoUrl, thumbUrl, avatarUrl] = await Promise.all([
    withUrls && ready ? viewUrl(videoPath(row.id, row.secret, row.ext)) : null,
    withUrls && (row.thumb_path || row.has_thumb) ? viewUrl(row.thumb_path ?? thumbPath(row.id, row.secret)) : null,
    row.owner_avatar ? viewUrl(row.owner_avatar) : null,
  ]);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    privacy: row.privacy,
    mimeType: row.mime_type,
    durationMs: trimOf(row) ? trimOf(row)!.endMs - trimOf(row)!.startMs : row.duration_ms,
    originalDurationMs: row.duration_ms,
    trim: trimOf(row),
    source: row.source,
    link: { hasPassword: Boolean(row.link_password_hash), expiresAt: row.link_expires_at ? new Date(row.link_expires_at).getTime() : null },
    size: row.size_bytes == null ? null : Number(row.size_bytes),
    views: row.views,
    createdAt: new Date(row.created_at).getTime(),
    archived: row.archived_at !== null,
    owner: { id: row.owner_id, name: row.owner_name, email: row.owner_email, avatarUrl },
    videoUrl,
    // A trim hides parts in the player; don't hand viewers a one-click download of the uncut file.
    downloadUrl: videoUrl && (canDownloadFull || !trimOf(row)) ? downloadUrl(videoUrl) : null,
    thumbUrl,
  };
}

function trimOf(row: VideoRow): { startMs: number; endMs: number } | null {
  return row.trim_start_ms != null && row.trim_end_ms != null ? { startMs: row.trim_start_ms, endMs: row.trim_end_ms } : null;
}

async function rowById(id: string): Promise<VideoRow | null> {
  if (!VIDEO_ID_RE.test(id)) return null;
  const rows = await sql().unsafe<VideoRow[]>(`${VIDEO_SELECT} where v.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Decides whether `user` may watch the video. Returns the kind of access or null. */
export async function accessFor(row: VideoRow, user: CurrentUser | null): Promise<Access | null> {
  if (user && user.id === row.owner_id) return "owner";
  const member = user?.workspace.id === row.workspace_id;
  // Admins/owners of the workspace can always manage videos in it.
  if (member && (user!.role === "owner" || user!.role === "admin")) return "owner";
  if (row.privacy === "link") {
    if (member) return "member";
    if (row.link_expires_at && new Date(row.link_expires_at).getTime() < Date.now()) throw new LinkLockedError("expired");
    if (row.link_password_hash && !(await isUnlocked(row))) throw new LinkLockedError("password");
    return "link";
  }
  if (row.privacy === "workspace") return member ? "member" : null;
  if (user) {
    const rows = await sql()`select 1 from video_access where video_id = ${row.id} and email = ${user.email}`;
    if (rows.length) return "invited";
  }
  return null;
}

// ───────── password-protected links ─────────

const unlockCookie = (id: string) => `rcd_unlock_${id}`;
// Bound to the current password hash: changing or removing the password invalidates old unlocks.
const unlockValue = (row: Pick<VideoRow, "id" | "link_password_hash">) =>
  createHmac("sha256", authSecret()).update(`unlock:${row.id}:${row.link_password_hash}`).digest("base64url");

async function isUnlocked(row: VideoRow): Promise<boolean> {
  return (await cookies()).get(unlockCookie(row.id))?.value === unlockValue(row);
}

const ATTEMPT_WINDOW = "15 minutes";
const MAX_ATTEMPTS_PER_CLIENT = 8;
const MAX_ATTEMPTS_PER_VIDEO = 60;

export async function unlockVideo(id: string, password: string, clientIp: string) {
  const row = await rowById(id);
  if (!row || row.privacy !== "link" || !row.link_password_hash) throw new HttpError(404, "This video doesn't exist");
  if (row.link_expires_at && new Date(row.link_expires_at).getTime() < Date.now()) throw new LinkLockedError("expired");
  const db = sql();
  const clientKey = createHmac("sha256", authSecret()).update(`ip:${clientIp}`).digest("hex");
  // Record the attempt first, then count — in one statement, so concurrent guesses all see each other.
  const [attempt] = await db`
    with ins as (insert into unlock_attempts (video_id, client_key) values (${id}, ${clientKey}) returning id)
    select (select id from ins) as id,
      1 + count(*) filter (where client_key = ${clientKey}) as mine,
      1 + count(*) as total
    from unlock_attempts where video_id = ${id} and at > now() - ${ATTEMPT_WINDOW}::interval`;
  const mine = Number(attempt.mine);
  // The per-video cap only applies to clients that have already failed here, so someone hammering a
  // link can't lock out a viewer who types the right password the first time.
  if (mine > MAX_ATTEMPTS_PER_CLIENT || (mine > 1 && Number(attempt.total) > MAX_ATTEMPTS_PER_VIDEO)) {
    throw new HttpError(429, "Too many wrong passwords. Try again in 15 minutes.");
  }
  if (!(await verifyPassword(password, row.link_password_hash))) {
    db`delete from unlock_attempts where at < now() - interval '1 day'`.catch(() => {});
    throw new HttpError(403, "That password isn't right");
  }
  await db`delete from unlock_attempts where id = ${attempt.id}`;
  (await cookies()).set(unlockCookie(id), unlockValue(row), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // "none" so the unlock also works inside embeds on other sites (needs https, which production has).
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function canEdit(access: Access | null): boolean {
  return access === "owner";
}

/** Video for a viewer; throws 404 when it doesn't exist and 403 when they may not watch it. */
export async function getVideoFor(id: string, user: CurrentUser | null): Promise<{ video: Video; access: Access }> {
  const row = await rowById(id);
  if (!row) throw new HttpError(404, "This video doesn't exist");
  const access = await accessFor(row, user);
  if (!access) throw new HttpError(user ? 403 : 401, user ? "You don't have access to this video" : "Sign in to watch this video");
  return { video: await toVideo(row, true, access === "owner"), access };
}

export async function videoExists(id: string): Promise<boolean> {
  return (await rowById(id)) !== null;
}

export async function listVideos(user: CurrentUser, scope: LibraryScope, query = "", limit = 500): Promise<Video[]> {
  // Piggy-back housekeeping on library loads: recordings whose app never finished are marked failed after a day.
  failStaleRecordings().catch(() => {});
  const q = query.trim() ? `%${query.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const params: string[] = [user.workspace.id];
  let where: string;
  if (scope === "mine") {
    params.push(user.id);
    where = `v.workspace_id = $1 and v.owner_id = $2 and v.archived_at is null`;
  } else if (scope === "archive") {
    params.push(user.id);
    where = `v.workspace_id = $1 and v.owner_id = $2 and v.archived_at is not null`;
  } else {
    // "Workspace" is what the team shares (plus private videos the user was invited to) — not a copy of "My videos".
    params.push(user.email);
    where = `v.workspace_id = $1 and v.archived_at is null and (
      v.privacy = 'workspace'
      or exists (select 1 from video_access a where a.video_id = v.id and a.email = $2)
    )`;
  }
  if (q) {
    params.push(q);
    where += ` and v.title ilike $${params.length}`;
  }
  const rows = await sql().unsafe<VideoRow[]>(`${VIDEO_SELECT} where ${where} order by v.created_at desc limit ${Math.max(1, Math.min(500, Math.floor(limit) || 500))}`, params);
  return Promise.all(rows.map((r) => toVideo(r, true)));
}

export async function countVideos(user: CurrentUser): Promise<{ mine: number; workspace: number; archive: number }> {
  const [row] = await sql()`
    select
      count(*) filter (where owner_id = ${user.id} and archived_at is null) as mine,
      count(*) filter (where archived_at is null and (privacy = 'workspace'
        or exists (select 1 from video_access a where a.video_id = videos.id and a.email = ${user.email}))) as workspace,
      count(*) filter (where owner_id = ${user.id} and archived_at is not null) as archive
    from videos where workspace_id = ${user.workspace.id}`;
  return { mine: Number(row.mine), workspace: Number(row.workspace), archive: Number(row.archive) };
}

/** Starts a recording session (Loom's startNewRecordingSession): the share URL exists before the first frame. */
export async function createVideo(user: CurrentUser, title: string, mimeType: string, source: VideoSource = "recording") {
  const id = newVideoId();
  const secret = randomToken(12);
  const ext = mimeType.startsWith("video/webm") ? "webm" : "mp4";
  await sql()`insert into videos (id, workspace_id, owner_id, title, privacy, secret, mime_type, ext, source)
    values (${id}, ${user.workspace.id}, ${user.id}, ${title}, ${user.workspace.defaultPrivacy}, ${secret}, ${mimeType}, ${ext}, ${source})`;
  const upload = await uploadTokens(id, secret, ext);
  return { id, title, privacy: user.workspace.defaultPrivacy, upload };
}

export async function completeVideo(id: string, user: CurrentUser, durationMs: number, size: number) {
  const row = await requireOwned(id, user);
  const hasThumb = await thumbExists(row);
  await sql()`update videos set status = 'ready', duration_ms = ${Math.round(durationMs)}, size_bytes = ${Math.round(size)},
    has_thumb = ${hasThumb}, completed_at = now() where id = ${id}`;
}

async function thumbExists(row: VideoRow): Promise<boolean> {
  const { fileExists } = await import("./blob");
  return fileExists(thumbPath(row.id, row.secret));
}

/** Replaces the thumbnail with an image the owner picked (e.g. the current frame of the player). */
export async function setCustomThumbnail(id: string, user: CurrentUser, jpeg: Buffer): Promise<string> {
  const row = await requireOwned(id, user);
  const pathname = customThumbPath(row.id, row.secret, randomToken(6));
  await putPrivate(pathname, jpeg, "image/jpeg");
  const previous = row.thumb_path;
  await sql()`update videos set thumb_path = ${pathname}, has_thumb = true where id = ${id}`;
  if (previous) await deleteFile(previous).catch(() => {});
  return viewUrl(pathname);
}

export async function markThumbnail(id: string, user: CurrentUser) {
  await requireOwned(id, user);
  await sql()`update videos set has_thumb = true where id = ${id}`;
}

async function requireOwned(id: string, user: CurrentUser): Promise<VideoRow> {
  const row = await rowById(id);
  if (!row) throw new HttpError(404, "This video doesn't exist");
  if (!canEdit(await accessFor(row, user))) throw new HttpError(403, "Only the owner can change this video");
  return row;
}

export type VideoPatch = {
  title?: string;
  privacy?: Privacy;
  archived?: boolean;
  trim?: { startMs: number; endMs: number } | null;
  linkPassword?: string | null;
  linkExpiresAt?: number | null;
};

export async function updateVideo(id: string, user: CurrentUser, patch: VideoPatch) {
  const row = await requireOwned(id, user);
  const db = sql();
  if (patch.trim !== undefined) {
    if (patch.trim === null) await db`update videos set trim_start_ms = null, trim_end_ms = null where id = ${id}`;
    else {
      const start = Math.round(Number(patch.trim.startMs));
      const end = Math.round(Number(patch.trim.endMs));
      const total = row.duration_ms ?? 0;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > total + 500 || end - start < 1000) {
        throw new HttpError(400, "Keep at least one second of the video");
      }
      const clampedEnd = Math.min(end, total);
      // A trim that keeps everything is the same as no trim.
      if (start <= 0 && clampedEnd >= total) await db`update videos set trim_start_ms = null, trim_end_ms = null where id = ${id}`;
      else await db`update videos set trim_start_ms = ${start}, trim_end_ms = ${clampedEnd} where id = ${id}`;
    }
  }
  if (patch.linkPassword !== undefined) {
    if (patch.linkPassword === null || patch.linkPassword === "") await db`update videos set link_password_hash = null where id = ${id}`;
    else {
      if (patch.linkPassword.length < 6) throw new HttpError(400, "Use a password of at least 6 characters");
      await db`update videos set link_password_hash = ${await hashPassword(patch.linkPassword.slice(0, 200))} where id = ${id}`;
    }
  }
  if (patch.linkExpiresAt !== undefined) {
    if (patch.linkExpiresAt !== null && (!Number.isFinite(patch.linkExpiresAt) || patch.linkExpiresAt < Date.now())) {
      throw new HttpError(400, "Pick an expiry date in the future");
    }
    await db`update videos set link_expires_at = ${patch.linkExpiresAt === null ? null : new Date(patch.linkExpiresAt)} where id = ${id}`;
  }
  if (patch.title !== undefined) {
    const title = patch.title.trim().slice(0, 200);
    if (!title) throw new HttpError(400, "Give the video a title");
    await db`update videos set title = ${title} where id = ${id}`;
  }
  if (patch.privacy !== undefined) {
    if (!(patch.privacy in PRIVACY_LABELS)) throw new HttpError(400, "Unknown privacy setting");
    await db`update videos set privacy = ${patch.privacy} where id = ${id}`;
  }
  if (patch.archived !== undefined) {
    await db`update videos set archived_at = ${patch.archived ? new Date() : null} where id = ${id}`;
  }
}

export async function deleteVideo(id: string, user: CurrentUser) {
  const row = await requireOwned(id, user);
  await sql()`delete from videos where id = ${id}`;
  await deletePrefix(`videos/${row.id}/`).catch((err) => console.error("blob cleanup failed", id, err));
}

export async function listAccess(id: string, user: CurrentUser): Promise<string[]> {
  await requireOwned(id, user);
  return (await sql()`select email from video_access where video_id = ${id} order by created_at`).map((r) => r.email as string);
}

export async function grantAccess(id: string, user: CurrentUser, email: string) {
  await requireOwned(id, user);
  const normalized = normalizeEmail(email);
  if (!isEmail(normalized)) throw new HttpError(400, "That doesn't look like an email address");
  await sql()`insert into video_access (video_id, email) values (${id}, ${normalized}) on conflict do nothing`;
  return normalized;
}

export async function revokeAccess(id: string, user: CurrentUser, email: string) {
  await requireOwned(id, user);
  await sql()`delete from video_access where video_id = ${id} and email = ${normalizeEmail(email)}`;
}

/**
 * Records that someone watched up to `positionMs` (on the trimmed timeline). The first report from a
 * viewer counts as a view; later ones only move their furthest position forward. Owners aren't counted.
 */
export async function recordProgress(id: string, access: Access, viewer: { userId: string | null; anonKey: string | null }, positionMs: number) {
  if (access === "owner") return;
  const key = viewer.userId ? `u:${viewer.userId}` : viewer.anonKey ? `a:${viewer.anonKey}` : null;
  if (!key) return;
  const pos = Math.max(0, Math.min(Math.round(positionMs) || 0, 24 * 3600 * 1000));
  const db = sql();
  const inserted = await db`
    insert into video_views (video_id, viewer_key, user_id, max_position_ms)
    select ${id}, ${key}, ${viewer.userId}, ${pos} where exists (select 1 from videos where id = ${id} and status = 'ready')
    on conflict (video_id, viewer_key) do update
      set max_position_ms = greatest(video_views.max_position_ms, excluded.max_position_ms), last_seen_at = now()
    returning (xmax = 0) as is_new`;
  if (inserted[0]?.is_new) await db`update videos set views = views + 1 where id = ${id}`;
}

export async function viewerStats(id: string, user: CurrentUser): Promise<ViewerStats> {
  const row = await requireOwned(id, user);
  const length = (trimOf(row) ? trimOf(row)!.endMs - trimOf(row)!.startMs : row.duration_ms) || 1;
  const pct = (ms: number) => Math.min(100, Math.round((ms / length) * 100));
  // Names are shown only for people the owner already shares a workspace with (or invited by email);
  // anyone else who happened to be signed in elsewhere is counted as anonymous.
  const rows = await sql()`
    select v.max_position_ms, v.last_seen_at, u.name, u.email, u.avatar_path,
      (u.id is not null and (
        exists (select 1 from memberships m where m.user_id = u.id and m.workspace_id = ${row.workspace_id})
        or exists (select 1 from video_access a where a.video_id = v.video_id and a.email = u.email)
      )) as known
    from video_views v left join users u on u.id = v.user_id
    where v.video_id = ${id} order by v.last_seen_at desc limit 500`;
  const signedIn = rows.filter((r) => r.known);
  const anon = rows.filter((r) => !r.known);
  const viewers = await Promise.all(
    signedIn.map(async (r) => ({
      name: r.name as string,
      email: r.email as string,
      avatarUrl: r.avatar_path ? await viewUrl(r.avatar_path) : null,
      percent: pct(r.max_position_ms),
      lastSeenAt: new Date(r.last_seen_at).getTime(),
    })),
  );
  const avg = anon.length ? Math.round(anon.reduce((a, r) => a + pct(r.max_position_ms), 0) / anon.length) : 0;
  return { viewers, anonymous: { count: anon.length, avgPercent: avg }, total: rows.length };
}

export async function failStaleRecordings() {
  // Recordings whose desktop app never finished (crash, quit) are marked failed after a day.
  await sql()`update videos set status = 'failed' where status = 'recording' and created_at < now() - interval '1 day'`;
}
