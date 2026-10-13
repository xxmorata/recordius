import { HttpError, readJson, requireUser, route } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { createVideo, listVideos, type LibraryScope } from "@/lib/videos";

/** Desktop: start a recording session — returns the share URL and scoped upload tokens up front. */
export const POST = route(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ title?: unknown; mimeType?: unknown; source?: unknown }>(req);
  const mimeType = typeof body.mimeType === "string" && body.mimeType.startsWith("video/") ? body.mimeType : "video/mp4";
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : defaultTitle();
  const created = await createVideo(user, title, mimeType, body.source === "upload" ? "upload" : "recording");
  return Response.json({ ...created, shareUrl: `${appUrl(req)}/share/${created.id}` });
});

export const GET = route(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") ?? "mine") as LibraryScope;
  if (!["mine", "workspace", "archive"].includes(scope)) throw new HttpError(400, "Unknown scope");
  const limit = Number(url.searchParams.get("limit")) || 500;
  return Response.json({ videos: await listVideos(user, scope, url.searchParams.get("q") ?? "", limit) }, { headers: { "cache-control": "no-store" } });
});

function defaultTitle(): string {
  const d = new Date();
  return `Recording ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}
