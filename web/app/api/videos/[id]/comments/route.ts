import { currentUser, readJson, route } from "@/lib/auth";
import { addComment, listComments } from "@/lib/videos";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  return Response.json({ comments: await listComments((await params).id, await currentUser()) }, { headers: { "cache-control": "no-store" } });
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  const body = (await readJson<{ body?: unknown; atMs?: unknown } | null>(req)) ?? {};
  const text = typeof body.body === "string" ? body.body : "";
  const id = await addComment((await params).id, await currentUser(), text, typeof body.atMs === "number" ? body.atMs : null);
  return Response.json({ id });
});
