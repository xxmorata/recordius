import { appUrl } from "@/lib/env";
import { publicPreview } from "@/lib/videos";

/**
 * oEmbed (https://oembed.com) so a pasted link becomes a playable video in Notion, Slack, Confluence, etc.
 * Works only for videos anyone with the link can watch; everything else falls back to a plain link.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const target = url.searchParams.get("url") ?? "";
  if ((url.searchParams.get("format") ?? "json") !== "json") return new Response("Only JSON is supported", { status: 501 });
  const origin = appUrl(req);
  let id: string | null = null;
  try {
    const t = new URL(target);
    const m = /^\/(?:share|embed)\/([a-f0-9]{32})\/?$/.exec(t.pathname);
    if (t.origin === origin && m) id = m[1];
  } catch {}
  const preview = id ? await publicPreview(id) : null;
  if (!preview) return Response.json({ error: "not found" }, { status: 404 });
  const maxW = Number(url.searchParams.get("maxwidth")) || 1280;
  const width = Math.min(1280, Math.max(240, maxW));
  const height = Math.round((width * 9) / 16);
  return Response.json(
    {
      type: "video",
      version: "1.0",
      title: preview.title,
      author_name: preview.ownerName,
      provider_name: "Recordius",
      provider_url: origin,
      width,
      height,
      html: `<iframe src="${origin}/embed/${preview.id}" width="${width}" height="${height}" frameborder="0" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`,
      ...(preview.thumbPath ? { thumbnail_url: `${origin}/api/videos/${preview.id}/poster`, thumbnail_width: 1280, thumbnail_height: 720 } : {}),
      ...(preview.durationMs ? { duration: Math.round(preview.durationMs / 1000) } : {}),
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
