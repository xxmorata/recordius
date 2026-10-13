import { redirect } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { currentUser } from "@/lib/auth";
import { viewUrl } from "@/lib/blob";
import { schemaReady } from "@/lib/db";
import { countVideos } from "@/lib/videos";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await schemaReady())) redirect("/setup");
  const user = await currentUser();
  if (!user) redirect("/login");
  const [counts, avatarUrl] = await Promise.all([countVideos(user), user.avatarPath ? viewUrl(user.avatarPath) : null]);
  return (
    <div className="flex min-h-dvh">
      <Sidebar
        user={{ name: user.name, email: user.email, avatarUrl, role: user.role }}
        workspace={user.workspace.name}
        counts={counts}
      />
      <main className="min-w-0 flex-1 pt-14 lg:pt-0">
        <div className="mx-auto max-w-[1180px] px-5 py-6 sm:px-8 sm:py-8">{children}</div>
      </main>
    </div>
  );
}
