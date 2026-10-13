import { createSession, readJson, route, setSessionCookie, HttpError } from "@/lib/auth";
import { createWorkspaceWithOwner, signupAllowed } from "@/lib/workspace";

export const POST = route(async (req: Request) => {
  const mode = await signupAllowed();
  if (mode === "closed") throw new HttpError(403, "This Recordius needs an invite link to join");
  const body = await readJson<{ name?: string; email?: string; password?: string; workspaceName?: string }>(req);
  const { userId } = await createWorkspaceWithOwner({
    name: String(body.name ?? ""),
    email: String(body.email ?? ""),
    password: String(body.password ?? ""),
    workspaceName: String(body.workspaceName ?? ""),
  });
  await setSessionCookie(await createSession(userId, req.headers.get("user-agent")));
  return Response.json({ ok: true });
});
