import { after } from "next/server";
import { sql } from "./db";
import { deleteFile, fileSize, storage, videoPath } from "./blob";
import { randomToken } from "./ids";
import { repairedFile, repairedSize, scanMp4 } from "./mp4-index";

/*
 * Adds a seek index to recordings that don't have one (see lib/mp4-index.ts), in the background:
 * the first time such a video is opened after an upload, or on demand for a whole workspace (admins,
 * POST /api/videos/reindex). The repaired copy is written next to the original and the video is pointed
 * at it; the original is deleted hours later, when every link already handed out has expired.
 *
 * One attempt at a time per video (claimed in the database, so several server instances or viewers
 * never repair the same file twice); after three failed attempts the video is left as it is.
 */

const MAX_ATTEMPTS = 3;
/** Between attempts (the first one often runs seconds after the upload, before the file is readable everywhere). */
const RETRY_AFTER_MINUTES = 2;
const KEEP_OLD_FILE_HOURS = 7; // > VIEW_URL_TTL_MS + the stable-window rounding
/** A serverless function has limited time and memory: very large files are left alone there. */
const SERVERLESS_MAX_BYTES = 1.5 * 1024 ** 3;

type Claim = {
  id: string;
  secret: string;
  ext: string;
  mime_type: string;
  size_bytes: string | number | null;
  seek_index_attempts: number;
  file_path: string | null;
};

export type ReindexResult = "ready" | "failed" | "busy";

/** Claims the video (unless another attempt is running) and repairs its file. */
export async function reindexVideo(id: string): Promise<ReindexResult> {
  const db = sql();
  const claimed = await db<Claim[]>`
    update videos set seek_index_started_at = now(), seek_index_attempts = seek_index_attempts + 1
    where id = ${id} and status = 'ready' and seek_index = 'pending'
      and (seek_index_started_at is null or seek_index_started_at < now() - interval '15 minutes')
    returning id, secret, ext, mime_type, size_bytes, seek_index_attempts, file_path`;
  const row = claimed[0];
  if (!row) return "busy";
  const giveUp = async (why: string) => {
    console.warn(`[recordius] seek index for ${id} not added: ${why}`);
    await db`update videos set seek_index = 'failed', seek_index_started_at = null where id = ${id}`;
    return "failed" as const;
  };
  const oldPath = row.file_path ?? videoPath(row.id, row.secret, row.ext);
  const newPath = `videos/${row.id}/${row.secret}/video-${randomToken(6)}.${row.ext}`;
  // RECORDIUS_DEBUG=reindex logs every stage with timings (to see where a repair spends its time).
  const t0 = Date.now();
  const stage = (what: string) => process.env.RECORDIUS_DEBUG?.includes("reindex") && console.log(`[recordius] seek index ${id}: ${what} (+${Date.now() - t0} ms)`);
  try {
    stage("claimed");
    const size = (await fileSize(oldPath)) ?? Number(row.size_bytes ?? 0);
    stage(`size ${size}`);
    if (!size) return giveUp("the file is missing");
    if (process.env.VERCEL && size > SERVERLESS_MAX_BYTES) return giveUp(`${Math.round(size / 1024 ** 2)} MB is too large to rewrite in a serverless function`);
    const driver = storage();
    // A file uploaded a moment ago can take a few seconds to become readable (Vercel Blob): wait for it.
    const open = async (range?: { start: number; end: number }) => {
      for (let attempt = 1; ; attempt++) {
        try {
          stage(`opening${range ? " (range)" : ""}, attempt ${attempt}`);
          const stream = await driver.readStream(oldPath, range);
          stage("opened");
          return stream;
        } catch (err) {
          stage(`open failed: ${String((err as Error)?.message ?? err)}`);
          if (attempt >= 8 || !/\b404\b|ENOENT|NoSuchKey|NotFound/i.test(String((err as Error)?.message ?? err))) throw err;
          await new Promise((r) => setTimeout(r, 2000));
          stage("retrying");
        }
      }
    };
    let source = await open();
    if (process.env.RECORDIUS_DEBUG?.includes("reindex")) {
      let bytes = 0;
      let chunks = 0;
      source = source.pipeThrough(
        new TransformStream({
          transform: (c, ctl) => {
            bytes += c.length;
            chunks++;
            ctl.enqueue(c);
          },
          flush: () => {
            stage(`read ${bytes} bytes in ${chunks} chunks`);
          },
        }),
      );
    }
    stage("scanning");
    const plan = await scanMp4(source, size);
    stage(plan ? `scanned: ${plan.durationMs} ms of video, usable ${plan.usableSize} bytes` : "scanned: nothing to do");
    if (!plan) {
      // WebM, a regular MP4 (browser upload) or a recording the desktop app already indexed.
      await db`update videos set seek_index = 'ready', seek_index_started_at = null where id = ${id}`;
      return "ready";
    }
    // Right after an upload, one node of the storage can still answer a range request with nothing: try again.
    for (let tries = 1; ; tries++) {
      try {
        const middle = await open({ start: plan.headerEnd, end: plan.usableSize - 1 });
        stage("reading + writing the repaired copy");
        await driver.putStream(newPath, repairedFile(plan, middle), row.mime_type.split(";")[0]);
        stage("written");
        break;
      } catch (err) {
        if (tries >= 3 || !/changed while it was being read/.test(String((err as Error)?.message))) throw err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    const written = await fileSize(newPath);
    stage(`verified ${written} bytes`);
    if (written !== repairedSize(plan)) throw new Error(`the repaired file is ${written} bytes, expected ${repairedSize(plan)}`);
    // Only announce the new file once it can actually be fetched (Vercel Blob takes a few seconds): the
    // page swaps to it the moment the video says "ready".
    for (let attempt = 1; ; attempt++) {
      try {
        const probe = await driver.readStream(newPath, { start: 0, end: 15 });
        await probe.cancel().catch(() => {});
        break;
      } catch (err) {
        if (attempt >= 15) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    stage("readable");
    await db.begin(async (tx) => {
      await tx`update videos set file_path = ${newPath}, size_bytes = ${written}, seek_index = 'ready', seek_index_started_at = null,
        duration_ms = coalesce(duration_ms, ${plan.durationMs}) where id = ${id}`;
      await tx`insert into stale_files (pathname, delete_after) values (${oldPath}, now() + ${`${KEEP_OLD_FILE_HOURS} hours`}::interval)
        on conflict (pathname) do nothing`;
    });
    console.log(`[recordius] seek index added to ${id} (${Math.round(written / 1024 ** 2)} MB, ${Math.round(plan.durationMs / 1000)} s)`);
    return "ready";
  } catch (err) {
    await deleteFile(newPath).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    if (row.seek_index_attempts >= MAX_ATTEMPTS) return giveUp(`${message} (after ${row.seek_index_attempts} attempts)`);
    console.warn(`[recordius] seek index for ${id} failed (attempt ${row.seek_index_attempts}): ${message}`);
    // Not again right away: the next attempt is allowed once the claim is RETRY_AFTER_MINUTES old.
    await db`update videos set seek_index_started_at = now() - interval '15 minutes' + ${`${RETRY_AFTER_MINUTES} minutes`}::interval where id = ${id}`;
    return "failed";
  }
}

/** Repairs the video after the current response has been sent (or right away, outside a request). */
export function scheduleReindex(id: string) {
  const run = () => reindexVideo(id).catch((err) => console.error("[recordius] seek index", id, err));
  try {
    after(run);
  } catch {
    void run();
  }
}

/** Every pending video of a workspace, oldest first, within a time budget. */
export async function reindexWorkspace(workspaceId: string, { limit = 50, budgetMs = 240_000 } = {}) {
  const started = Date.now();
  const rows = await sql()<{ id: string }[]>`
    select id from videos where workspace_id = ${workspaceId} and status = 'ready' and seek_index = 'pending'
      and (seek_index_started_at is null or seek_index_started_at < now() - interval '15 minutes')
    order by created_at asc limit ${Math.min(500, Math.max(1, limit))}`;
  const result = { processed: 0, ready: 0, failed: 0, busy: 0, remaining: 0 };
  for (const { id } of rows) {
    if (Date.now() - started > budgetMs) break;
    const r = await reindexVideo(id);
    result.processed++;
    result[r]++;
  }
  const [{ n }] = await sql()<{ n: string }[]>`select count(*)::text as n from videos where workspace_id = ${workspaceId} and status = 'ready' and seek_index = 'pending'`;
  result.remaining = Number(n);
  return result;
}

/** Deletes replaced files whose grace period is over. Best effort; a file that's already gone is fine. */
export async function purgeStaleFiles() {
  const due = await sql()<{ pathname: string }[]>`delete from stale_files where delete_after < now() returning pathname`;
  for (const { pathname } of due) await deleteFile(pathname).catch((err) => console.warn("[recordius] couldn't delete", pathname, err?.message));
}
