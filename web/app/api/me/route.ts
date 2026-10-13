import { requireUser, route } from "@/lib/auth";
import { viewUrl } from "@/lib/blob";
import { appUrl } from "@/lib/env";

/** Who am I — used by the desktop app to verify its token and show the account. */
export const GET = route(async (req: Request) => {
  const user = await requireUser({ device: true });
  return Response.json({
    user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarPath ? await viewUrl(user.avatarPath) : null },
    workspace: user.workspace,
    role: user.role,
    serverUrl: appUrl(req),
  });
});
