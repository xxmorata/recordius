import { requireUser, route } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { createPasswordReset } from "@/lib/workspace";

/** Admin-generated password reset link (hand it to the member; no email provider needed). */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const token = await createPasswordReset(await requireUser(), (await params).id);
  return Response.json({ url: `${appUrl(req)}/reset/${token}` });
});
