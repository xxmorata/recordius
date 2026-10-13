import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { storageProvider } from "@/lib/blob";
import { verifyRead } from "@/lib/storage/local";

const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".jpg": "image/jpeg" };

/** Serves a file from local storage for a signed, unexpired URL (with Range support for seeking). */
export async function GET(req: Request) {
  if (storageProvider() !== "local") return new Response("Not found", { status: 404 });
  const target = verifyRead(new URL(req.url).searchParams);
  if (!target) return new Response("This link has expired or isn't valid", { status: 403 });
  const info = await stat(target.file).catch(() => null);
  if (!info?.isFile()) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "content-type": TYPES[extname(target.file)] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  });
  if (target.downloadName) headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(target.downloadName)}`);

  const size = info.size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(range[2])); // "bytes=-500": the last 500 bytes
    }
    if (start > end || start >= size) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("content-length", String(size === 0 ? 0 : end - start + 1));
  if (req.method === "HEAD" || size === 0) return new Response(null, { status: range ? 206 : 200, headers });
  const body = Readable.toWeb(createReadStream(target.file, { start, end })) as ReadableStream;
  return new Response(body, { status: range && (range[1] || range[2]) ? 206 : 200, headers });
}

export const HEAD = GET;
