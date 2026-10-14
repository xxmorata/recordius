import { sql } from "./db";
import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import {
  customThumbPath,
  deleteFile,
  deletePrefix,
  downloadUrl,
  fileExists,
  fileSize,
  finishMultipart,
  MAX_VIDEO_BYTES,
  PART_SIZE,
  partUrl,
  putPrivate,
  singlePutUrl,
  startMultipart,
  storageProvider,
  thumbPath,
  uploadGrant,
  videoPath,
  viewUrl,
} from "./blob";
import { HttpError, canManageWorkspace, type CurrentUser } from "./auth";
import { VIDEO_ID_RE, hashPassword, isEmail, newVideoId, normalizeEmail, randomToken, verifyPassword } from "./ids";
import { authSecret, secureCookies } from "./env";
import { ipBucket } from "./client-ip";
import { StorageError } from "./storage/local";

import { PRIVACY_LABELS, type Comment, type Access, type LibraryScope, type Privacy, type Video, type VideoSource, type VideoStatus, type ViewerStats } from "./types";
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

/**
 * @param canDownloadFull  the owner/admins: a download link even when a trim hides parts in the player
 * @param inWorkspace      people with account-level access see the owner's email; link viewers only the name
 */
/**
 * @param list  library/recent lists: only the thumbnail and avatar are signed (the player and download links
 *              are fetched when a video is opened), and avatars are signed once per list via `avatarCache`.
 */
async function toVideo(
  row: VideoRow,
  withUrls: boolean,
  { canDownloadFull, inWorkspace, list = false, avatarCache }: { canDownloadFull: boolean; inWorkspace: boolean; list?: boolean; avatarCache?: Map<string, Promise<string>> },
): Promise<Video> {
  const ready = row.status === "ready";
  const signAvatar = (p: string) => {
    if (!avatarCache) return viewUrl(p);
    if (!avatarCache.has(p)) avatarCache.set(p, viewUrl(p));
    return avatarCache.get(p)!;
  };
  const [videoUrl, thumbUrl, avatarUrl] = await Promise.all([
    withUrls && ready && !list ? viewUrl(videoPath(row.id, row.secret, row.ext)) : null,
    withUrls && (row.thumb_path || row.has_thumb) ? viewUrl(row.thumb_path ?? thumbPath(row.id, row.secret)) : null,
    row.owner_avatar ? signAvatar(row.owner_avatar) : null,
  ]);
  // A trim hides parts in the player; don't hand viewers a one-click download of the uncut file.
  const canDownload = withUrls && ready && (canDownloadFull || !trimOf(row));
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
    owner: { id: row.owner_id, name: row.owner_name, email: inWorkspace ? row.owner_email : "", avatarUrl },
    videoUrl,
    downloadUrl: canDownload && !list ? await downloadUrl(videoPath(row.id, row.secret, row.ext), downloadName(row.title, row.ext)) : null,
    canDownload,
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
    // Emails aren't verified, so a share only counts for an account that already existed when the video
    // was shared — registering someone else's address later doesn't unlock their videos.
    const rows = await sql()`select 1 from video_access a join users u on u.email = a.email
      where a.video_id = ${row.id} and a.email = ${user.email} and a.created_at >= u.created_at`;
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
const MAX_ATTEMPTS_PER_VIDEO = 60; // for clients that already failed here
const HARD_CAP_PER_VIDEO = 300; // for everyone: rotating IPs can't keep guessing forever

export async function unlockVideo(id: string, password: string, clientIp: string) {
  const row = await rowById(id);
  if (!row || row.privacy !== "link" || !row.link_password_hash) throw new HttpError(404, "This video doesn't exist");
  if (row.link_expires_at && new Date(row.link_expires_at).getTime() < Date.now()) throw new LinkLockedError("expired");
  const db = sql();
  const clientKey = createHmac("sha256", authSecret()).update(`ip:${ipBucket(clientIp)}`).digest("hex");
  // Record the attempt first, then count — serialized per video with an advisory lock, so concurrent
  // guesses always count each other (separate statements wouldn't see each other's uncommitted rows).
  const attempt = await db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`unlock:${id}`}))`;
    const [inserted] = await tx`insert into unlock_attempts (video_id, client_key) values (${id}, ${clientKey}) returning id`;
    const [counts] = await tx`select count(*) filter (where client_key = ${clientKey}) as mine, count(*) as total
      from unlock_attempts where video_id = ${id} and at > now() - ${ATTEMPT_WINDOW}::interval`;
    return { id: inserted.id, mine: counts.mine, total: counts.total };
  });
  const mine = Number(attempt.mine);
  // The per-video cap only applies to clients that have already failed here, so someone hammering a
  // link can't lock out a viewer who types the right password the first time.
  const total = Number(attempt.total);
  if (mine > MAX_ATTEMPTS_PER_CLIENT || (mine > 1 && total > MAX_ATTEMPTS_PER_VIDEO) || total > HARD_CAP_PER_VIDEO) {
    // Rejected without checking the password, so it doesn't count: being blocked never adds to the
    // video's total, and only real guesses can get near the hard cap.
    await db`delete from unlock_attempts where id = ${attempt.id}`;
    throw new HttpError(429, "Too many wrong passwords. Try again in 15 minutes.");
  }
  if (!(await verifyPassword(password, row.link_password_hash))) {
    db`delete from unlock_attempts where at < now() - interval '1 day'`.catch(() => {});
    throw new HttpError(403, "That password isn't right");
  }
  await db`delete from unlock_attempts where id = ${attempt.id}`;
  (await cookies()).set(unlockCookie(id), unlockValue(row), {
    httpOnly: true,
    secure: secureCookies(),
    // "none" so the unlock also works inside embeds on other sites (browsers allow that only over https).
    sameSite: secureCookies() ? "none" : "lax",
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
  return { video: await toVideo(row, true, { canDownloadFull: access === "owner", inWorkspace: access !== "link" }), access };
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
      or exists (select 1 from video_access a join users iu on iu.email = a.email where a.video_id = v.id and a.email = $2 and a.created_at >= iu.created_at)
    )`;
  }
  if (q) {
    params.push(q);
    where += ` and v.title ilike $${params.length}`;
  }
  const rows = await sql().unsafe<VideoRow[]>(`${VIDEO_SELECT} where ${where} order by v.created_at desc limit ${Math.max(1, Math.min(500, Math.floor(limit) || 500))}`, params);
  const avatarCache = new Map<string, Promise<string>>();
  return Promise.all(rows.map((r) => toVideo(r, true, { canDownloadFull: r.owner_id === user.id || canManageWorkspace(user), inWorkspace: true, list: true, avatarCache })));
}

export async function countVideos(user: CurrentUser): Promise<{ mine: number; workspace: number; archive: number }> {
  const [row] = await sql()`
    select
      count(*) filter (where owner_id = ${user.id} and archived_at is null) as mine,
      count(*) filter (where archived_at is null and (privacy = 'workspace'
        or exists (select 1 from video_access a join users iu on iu.email = a.email
          where a.video_id = videos.id and a.email = ${user.email} and a.created_at >= iu.created_at))) as workspace,
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
  const upload = await uploadGrant(id, secret, ext);
  return { id, title, privacy: user.workspace.defaultPrivacy, upload };
}

export async function completeVideo(id: string, user: CurrentUser, durationMs: number, size: number) {
  const row = await requireOwned(id, user);
  // Never mark a video ready whose file isn't there: the share page would show a broken player.
  // An empty file isn't a video either: the share page would show a broken player.
  if (!((await fileSize(videoPath(row.id, row.secret, row.ext))) ?? 0)) throw new HttpError(409, "The video file hasn't finished uploading yet", "file_missing");
  const hasThumb = await thumbExists(row);
  await sql()`update videos set status = 'ready', duration_ms = ${Math.round(durationMs)}, size_bytes = ${Math.round(size)},
    has_thumb = ${hasThumb}, completed_at = now() where id = ${id}`;
}

async function thumbExists(row: VideoRow): Promise<boolean> {
  return fileExists(thumbPath(row.id, row.secret));
}

/** "Weekly sync.mp4" — a safe file name for downloads. */
function downloadName(title: string, ext: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Recordius video";
  return `${base}.${ext}`;
}

// ───────── uploads through Recordius (s3 / local storage) ─────────

type UploadOp =
  | { op: "create"; file: "video" | "thumb" }
  | { op: "parts"; file: "video" | "thumb"; uploadId: string; partNumbers: number[] }
  | { op: "complete"; file: "video" | "thumb"; uploadId: string; parts: { partNumber: number; etag: string }[] }
  | { op: "put"; file: "thumb" };

/**
 * Hands out signed URLs to upload one video's own two files, to the person who recorded it, while it isn't
 * finished. With Vercel Blob the client tokens in the upload grant do this job instead.
 */
export async function handleUpload(id: string, user: CurrentUser, raw: unknown) {
  const provider = storageProvider();
  if (provider === "vercel-blob") throw new HttpError(400, "This server uploads straight to Vercel Blob — use the tokens from the upload grant");
  const row = await rowById(id);
  if (!row) throw new HttpError(404, "This video doesn't exist", "video_gone");
  if (row.owner_id !== user.id) throw new HttpError(403, "Only the person who recorded this video can upload it", "not_recorder");
  const body = (raw ?? {}) as Partial<UploadOp> & Record<string, unknown>;
  const file = body.file === "thumb" ? "thumb" : body.file === "video" ? "video" : null;
  if (!file) throw new HttpError(400, "file must be video or thumb");
  if (file === "video" && row.status === "ready") throw new HttpError(409, "This video has already finished uploading", "already_uploaded");
  const pathname = file === "video" ? videoPath(row.id, row.secret, row.ext) : thumbPath(row.id, row.secret);
  const contentType = file === "video" ? (row.ext === "webm" ? "video/webm" : "video/mp4") : "image/jpeg";
  const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
  switch (body.op) {
    case "create":
      return { uploadId: await startMultipart(pathname, contentType) };
    case "parts": {
      const nums = Array.isArray(body.partNumbers) ? body.partNumbers : [];
      const maxParts = Math.ceil(MAX_VIDEO_BYTES / PART_SIZE); // 20 GB in 8 MB parts
      if (!uploadId || !nums.length || nums.length > 100 || !nums.every((n) => Number.isInteger(n) && n >= 1 && n <= maxParts)) {
        throw new HttpError(400, `Ask for 1–100 part numbers between 1 and ${maxParts} (videos can be up to 20 GB)`);
      }
      const urls = await Promise.all(nums.map((n) => partUrl(pathname, uploadId, n as number))).catch(() => {
        throw new HttpError(400, "This upload doesn't exist or has expired — start it again");
      });
      return { urls: Object.fromEntries(nums.map((n, i) => [String(n), urls[i]])) };
    }
    case "complete": {
      const parts = Array.isArray(body.parts) ? body.parts : [];
      if (!uploadId || !parts.length || parts.length > 10_000 || !parts.every((p) => p && Number.isInteger(p.partNumber) && typeof p.etag === "string" && p.etag.length < 200)) {
        throw new HttpError(400, "Send the uploaded parts as [{ partNumber, etag }]");
      }
      try {
        await finishMultipart(pathname, uploadId, parts as { partNumber: number; etag: string }[]);
      } catch (err) {
        // Our own storage messages are safe to show; anything else (file-system or bucket errors) is logged only.
        if (err instanceof StorageError) throw new HttpError(400, `The upload couldn't be finished: ${err.message}`);
        console.error("[recordius] finishing an upload failed", err);
        throw new HttpError(400, "The upload couldn't be finished — the parts may have expired. Start the upload again.");
      }
      // Signed part URLs can't cap their own size, so check the assembled file.
      if (((await fileSize(pathname)) ?? 0) > (file === "video" ? MAX_VIDEO_BYTES : 5 * 1024 ** 2)) {
        await deleteFile(pathname).catch(() => {});
        throw new HttpError(413, file === "video" ? "Videos can be up to 20 GB" : "Thumbnails can be up to 5 MB");
      }
      return { ok: true };
    }
    case "put":
      if (file !== "thumb") throw new HttpError(400, "Videos are uploaded in parts");
      return { url: await singlePutUrl(pathname, contentType), contentType };
    default:
      throw new HttpError(400, "op must be create, parts, complete or put");
  }
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
  const row = await requireOwned(id, user);
  const pathname = thumbPath(row.id, row.secret);
  const size = await fileSize(pathname);
  if (size === null) throw new HttpError(409, "Upload the thumbnail first");
  if (size > 5 * 1024 ** 2) {
    await deleteFile(pathname).catch(() => {});
    throw new HttpError(413, "Thumbnails can be up to 5 MB");
  }
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
      // Rejected rather than cut: a silently shortened password could never be typed back in.
      if (patch.linkPassword.length > 200) throw new HttpError(400, "Use a password of at most 200 characters");
      await db`update videos set link_password_hash = ${await hashPassword(patch.linkPassword)} where id = ${id}`;
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
  const account = await sql()`select 1 from users where email = ${normalized}`;
  if (!account[0]) {
    throw new HttpError(
      404,
      "Nobody with this email has an account here yet. Invite them to your workspace first (Settings → Members), or share the link with a password instead.",
      "no_account",
    );
  }
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
        or exists (select 1 from video_access a where a.video_id = v.video_id and a.email = u.email and a.created_at >= u.created_at)
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

declare global {
  var __recordiusStaleCheck: number | undefined;
}

export async function failStaleRecordings() {
  // Recordings whose desktop app never finished (crash, quit) are marked failed after a day.
  // Piggy-backed on library loads, so at most every 10 minutes per server.
  if (Date.now() - (globalThis.__recordiusStaleCheck ?? 0) < 10 * 60 * 1000) return;
  globalThis.__recordiusStaleCheck = Date.now();
  await sql()`update videos set status = 'failed' where status = 'recording' and created_at < now() - interval '1 day'`;
}

// ───────── re-upload (desktop retry after a failed or interrupted upload) ─────────

/** Fresh upload tokens for a video that isn't finished yet (the original ones expire after 12 hours). */
export async function reissueUploadTokens(id: string, user: CurrentUser) {
  // The codes tell the desktop app it may drop the recording from its retry queue.
  if (!(await rowById(id))) throw new HttpError(404, "This video doesn't exist", "video_gone");
  const row = await requireOwned(id, user);
  if (row.owner_id !== user.id) throw new HttpError(403, "Only the person who recorded this video can upload it", "not_recorder");
  if (row.status === "ready") throw new HttpError(409, "This video has already finished uploading", "already_uploaded");
  return uploadGrant(row.id, row.secret, row.ext);
}

// ───────── public metadata for link previews / oEmbed ─────────

/** Only videos anyone can watch without a password (no account, not expired) get rich previews. */
export async function publicPreview(id: string) {
  const row = await rowById(id);
  if (!row || row.status !== "ready" || row.privacy !== "link" || row.link_password_hash) return null;
  if (row.link_expires_at && new Date(row.link_expires_at).getTime() < Date.now()) return null;
  return {
    id: row.id,
    title: row.title,
    ownerName: row.owner_name,
    durationMs: trimOf(row) ? trimOf(row)!.endMs - trimOf(row)!.startMs : row.duration_ms,
    thumbPath: row.thumb_path || row.has_thumb ? (row.thumb_path ?? thumbPath(row.id, row.secret)) : null,
  };
}

// ───────── comments ─────────

const COMMENT_ACCESS: Access[] = ["owner", "member", "invited"];

async function commentAccess(id: string, user: CurrentUser | null) {
  if (!user) throw new HttpError(401, "Sign in to see comments");
  const row = await rowById(id);
  if (!row) throw new HttpError(404, "This video doesn't exist");
  const access = await accessFor(row, user).catch(() => null);
  if (!access || !COMMENT_ACCESS.includes(access)) throw new HttpError(403, "Comments are only for people in this workspace");
  return { row, access };
}

/**
 * Comment timestamps are stored on the FILE timeline, so they keep pointing at the same moment when the
 * owner changes the trim; they're shown on the trimmed timeline (a comment in a cut part shows no time).
 */
export async function listComments(id: string, user: CurrentUser | null): Promise<Comment[]> {
  const { access, row } = await commentAccess(id, user);
  const trim = trimOf(row);
  const toTimeline = (fileMs: number | null) => {
    if (fileMs == null) return null;
    if (!trim) return fileMs;
    return fileMs < trim.startMs || fileMs > trim.endMs ? null : fileMs - trim.startMs;
  };
  const avatars = new Map<string, Promise<string>>(); // one signed URL per author, not per comment
  const rows = await sql()`
    select c.id, c.body, c.at_ms, c.created_at, u.id as user_id, u.name, u.avatar_path
    from video_comments c join users u on u.id = c.user_id
    where c.video_id = ${id} order by coalesce(c.at_ms, 2147483647), c.created_at limit 1000`;
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id as string,
      body: r.body as string,
      atMs: toTimeline(r.at_ms as number | null),
      createdAt: new Date(r.created_at).getTime(),
      author: {
        id: r.user_id as string,
        name: r.name as string,
        avatarUrl: r.avatar_path ? await (avatars.get(r.avatar_path) ?? avatars.set(r.avatar_path, viewUrl(r.avatar_path)).get(r.avatar_path)!) : null,
      },
      canDelete: r.user_id === user!.id || access === "owner",
    })),
  );
}

export async function addComment(id: string, user: CurrentUser | null, body: string, atMs: number | null): Promise<string> {
  const { row } = await commentAccess(id, user);
  const text = body.trim();
  if (!text) throw new HttpError(400, "Write something first");
  if (text.length > 4000) throw new HttpError(400, "Comments can be up to 4000 characters");
  // atMs comes from the player (trimmed timeline); it's stored as a position in the file.
  const trim = trimOf(row);
  const length = (trim ? trim.endMs - trim.startMs : row.duration_ms) ?? 0;
  const at = atMs == null || !Number.isFinite(atMs) ? null : Math.max(0, Math.min(Math.round(atMs), length)) + (trim?.startMs ?? 0);
  const [c] = await sql()`insert into video_comments (video_id, user_id, body, at_ms) values (${id}, ${user!.id}, ${text}, ${at}) returning id`;
  return c.id as string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function deleteComment(id: string, commentId: string, user: CurrentUser | null) {
  const { access } = await commentAccess(id, user);
  if (!UUID_RE.test(commentId)) throw new HttpError(404, "That comment doesn't exist");
  const rows = await sql()`select user_id from video_comments where id = ${commentId} and video_id = ${id}`;
  if (!rows[0]) throw new HttpError(404, "That comment doesn't exist");
  if (rows[0].user_id !== user!.id && access !== "owner") throw new HttpError(403, "You can only delete your own comments");
  await sql()`delete from video_comments where id = ${commentId}`;
}
