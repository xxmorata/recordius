import { HttpError, createDeviceToken, readJson, requireUser, route } from "@/lib/auth";
import { appUrl } from "@/lib/env";

/**
 * Connects the desktop app to this account. The browser session creates a device token and the
 * page opens `recordius://connect?...`; the desktop app stores the token and never sees the password.
 */
export const POST = route(async (req: Request) => {
  const user = await requireUser();
  if (user.via !== "session") throw new HttpError(403, "Connect from the browser");
  const body = await readJson<{ deviceName?: string }>(req);
  const name = String(body.deviceName ?? "").trim() || "Recordius desktop";
  const { token } = await createDeviceToken(user.id, user.workspace.id, name);
  const server = appUrl(req);
  const deepLink = `recordius://connect?${new URLSearchParams({ server, token }).toString()}`;
  return Response.json({ deepLink, server, token });
});
