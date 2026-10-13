import { LibraryView } from "@/components/LibraryView";
import { canManageWorkspace, requireUser } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { listVideos, type LibraryScope } from "@/lib/videos";

export const metadata = { title: "Library" };

export default async function Library({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const user = await requireUser();
  const { scope: raw } = await searchParams;
  const scope: LibraryScope = raw === "workspace" || raw === "archive" ? raw : "mine";
  const videos = await listVideos(user, scope);
  return <LibraryView key={scope} initial={videos} scope={scope} origin={appUrl()} userId={user.id} canManageAll={canManageWorkspace(user)} />;
}
