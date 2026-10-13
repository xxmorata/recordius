import { requireUser, route } from "@/lib/auth";
import { listMembers } from "@/lib/workspace";

export const GET = route(async () => {
  return Response.json({ members: await listMembers(await requireUser()) });
});
