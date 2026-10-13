import { createSession, readJson, route, setSessionCookie, HttpError } from "@/lib/auth";
import { createWorkspaceWithOwner, signupAllowed } from "@/lib/workspace";
import { clientIp } from "@/lib/client-ip";
import { ipKey, limit } from "@/lib/rate-limit";
import { timingSafeEqual } from "node:crypto";

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const POST = route(async (req: Request) => {
  const mode = await signupAllowed();
  if (mode === "closed") throw new HttpError(403, "This Recordius needs an invite link to join");
  const body = await readJson<{ name?: string; email?: string; password?: string; workspaceName?: string; setupToken?: string }>(req);
  // Optional: on a public server, SETUP_TOKEN makes sure the first account (the owner) is really yours.
  if (mode === "setup" && process.env.SETUP_TOKEN && !sameSecret(String(body.setupToken ?? ""), process.env.SETUP_TOKEN)) {
    throw new HttpError(403, "That setup token isn't right — it's the SETUP_TOKEN value in your server settings");
  }
  await limit([{ scope: "signup-ip", key: ipKey(clientIp(req)), limit: 10, window: "1 hour" }], "Too many sign-ups from your network. Try again in an hour.");
  const { userId } = await createWorkspaceWithOwner({
    name: String(body.name ?? ""),
    email: String(body.email ?? ""),
    password: String(body.password ?? ""),
    workspaceName: String(body.workspaceName ?? ""),
  });
  await setSessionCookie(await createSession(userId, req.headers.get("user-agent")));
  return Response.json({ ok: true });
});
