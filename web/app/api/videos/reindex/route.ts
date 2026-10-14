import { HttpError, canManageWorkspace, readJson, requireUser, route } from "@/lib/auth";
import { reindexWorkspace } from "@/lib/reindex";

// Repairing a file means streaming it through this server once: give the function time for a batch.
export const maxDuration = 300;

/**
 * Adds seek indexes to a workspace's older recordings, a batch at a time (admins; scripts/reindex.mjs
 * calls this until nothing is left). Each video is also repaired by itself the first time it's opened.
 */
export const POST = route(async (req: Request) => {
  const user = await requireUser();
  if (!canManageWorkspace(user)) throw new HttpError(403, "Only workspace owners and admins can do this");
  const body = await readJson<{ limit?: number }>(req).catch(() => ({}) as { limit?: number });
  const limit = Number.isInteger(body.limit) && body.limit! > 0 ? body.limit! : 50;
  return Response.json(await reindexWorkspace(user.workspace.id, { limit, budgetMs: 240_000 }));
});
