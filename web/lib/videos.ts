import { sql } from "./db";
import { deletePrefix, downloadUrl, thumbPath, uploadTokens, videoPath, viewUrl } from "./blob";
import { HttpError, type CurrentUser } from "./auth";
import { VIDEO_ID_RE, isEmail, newVideoId, normalizeEmail, randomToken } from "./ids";

import { PRIVACY_LABELS, type Access, type LibraryScope, type Privacy, type Video, type VideoStatus } from "./types";
export { PRIVACY_LABELS };
export type { Access, LibraryScope, Privacy, Video, VideoStatus };

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
};

const VIDEO_SELECT = `
  select v.*, u.name as owner_name, u.email as owner_email, u.avatar_path as owner_avatar
  from videos v join users u on u.id = v.owner_id`;

async function toVideo(row: VideoRow, withUrls: boolean): Promise<Video> {
  const ready = row.status === "ready";
  const [videoUrl, thumbUrl, avatarUrl] = await Promise.all([
    withUrls && ready ? viewUrl(videoPath(row.id, row.secret, row.ext)) : null,
    withUrls && row.has_thumb ? viewUrl(thumbPath(row.id, row.secret)) : null,
    row.owner_avatar ? viewUrl(row.owner_avatar) : null,
  ]);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    privacy: row.privacy,
    mimeType: row.mime_type,
    durationMs: row.duration_ms,
    size: row.size_bytes == null ? null : Number(row.size_bytes),
    views: row.views,
    createdAt: new Date(row.created_at).getTime(),
    archived: row.archived_at !== null,
    owner: { id: row.owner_id, name: row.owner_name, email: row.owner_email, avatarUrl },
    videoUrl,
    downloadUrl: videoUrl ? downloadUrl(videoUrl) : null,
    thumbUrl,
  };
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
  if (row.privacy === "link") return member ? "member" : "link";
  if (row.privacy === "workspace") return member ? "member" : null;
  if (user) {
    const rows = await sql()`select 1 from video_access where video_id = ${row.id} and email = ${user.email}`;
    if (rows.length) return "invited";
  }
  return null;
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
  return { video: await toVideo(row, true), access };
}

export async function videoExists(id: string): Promise<boolean> {
  return (await rowById(id)) !== null;
}

export async function listVideos(user: CurrentUser, scope: LibraryScope, query = ""): Promise<Video[]> {
  // Piggy-back housekeeping on library loads: recordings whose app never finished are marked failed after a day.
  failStaleRecordings().catch(() => {});
  const q = query.trim() ? `%${query.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const params: string[] = [user.workspace.id, user.id];
  let where: string;
  if (scope === "mine") where = `v.workspace_id = $1 and v.owner_id = $2 and v.archived_at is null`;
  else if (scope === "archive") where = `v.workspace_id = $1 and v.owner_id = $2 and v.archived_at is not null`;
  else {
    // Everything shared with the workspace, plus private videos the user was invited to.
    params.push(user.email);
    where = `v.workspace_id = $1 and v.archived_at is null and (
      v.owner_id = $2 or v.privacy = 'workspace'
      or exists (select 1 from video_access a where a.video_id = v.id and a.email = $3)
    )`;
  }
  if (q) {
    params.push(q);
    where += ` and v.title ilike $${params.length}`;
  }
  const rows = await sql().unsafe<VideoRow[]>(`${VIDEO_SELECT} where ${where} order by v.created_at desc limit 500`, params);
  return Promise.all(rows.map((r) => toVideo(r, true)));
}

export async function countVideos(user: CurrentUser): Promise<{ mine: number; workspace: number; archive: number }> {
  const [row] = await sql()`
    select
      count(*) filter (where owner_id = ${user.id} and archived_at is null) as mine,
      count(*) filter (where archived_at is null and (owner_id = ${user.id} or privacy = 'workspace'
        or exists (select 1 from video_access a where a.video_id = videos.id and a.email = ${user.email}))) as workspace,
      count(*) filter (where owner_id = ${user.id} and archived_at is not null) as archive
    from videos where workspace_id = ${user.workspace.id}`;
  return { mine: Number(row.mine), workspace: Number(row.workspace), archive: Number(row.archive) };
}

/** Starts a recording session (Loom's startNewRecordingSession): the share URL exists before the first frame. */
export async function createVideo(user: CurrentUser, title: string, mimeType: string) {
  const id = newVideoId();
  const secret = randomToken(12);
  const ext = mimeType.startsWith("video/webm") ? "webm" : "mp4";
  await sql()`insert into videos (id, workspace_id, owner_id, title, privacy, secret, mime_type, ext)
    values (${id}, ${user.workspace.id}, ${user.id}, ${title}, ${user.workspace.defaultPrivacy}, ${secret}, ${mimeType}, ${ext})`;
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

export async function updateVideo(id: string, user: CurrentUser, patch: { title?: string; privacy?: Privacy; archived?: boolean }) {
  await requireOwned(id, user);
  const db = sql();
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

/** Counts a view for everyone except the owner (and only once per status 'ready'). */
export async function recordView(id: string, access: Access) {
  if (access === "owner") return;
  await sql()`update videos set views = views + 1 where id = ${id} and status = 'ready'`;
}

export async function failStaleRecordings() {
  // Recordings whose desktop app never finished (crash, quit) are marked failed after a day.
  await sql()`update videos set status = 'failed' where status = 'recording' and created_at < now() - interval '1 day'`;
}
