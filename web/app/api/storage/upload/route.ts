import { storageProvider } from "@/lib/blob";
import { receiveWrite, verifyWrite } from "@/lib/storage/local";

/** Receives an upload part or a thumbnail for a signed, unexpired URL (local storage). */
export async function PUT(req: Request) {
  if (storageProvider() !== "local") return new Response("Not found", { status: 404 });
  const target = verifyWrite(new URL(req.url).searchParams);
  if (!target) return Response.json({ error: "This upload link has expired or isn't valid" }, { status: 403 });
  if (!req.body) return Response.json({ error: "Empty body" }, { status: 400 });
  try {
    const etag = await receiveWrite(target, req.body);
    return new Response(null, { status: 200, headers: { etag: `"${etag}"`, "access-control-expose-headers": "ETag" } });
  } catch (err) {
    const message = (err as Error).message;
    if (message === "Forbidden") return Response.json({ error: "This upload link has expired or isn't valid" }, { status: 403 });
    return Response.json({ error: message.startsWith("Too large") ? message : "The upload couldn't be saved" }, { status: message.startsWith("Too large") ? 413 : 400 });
  }
}
