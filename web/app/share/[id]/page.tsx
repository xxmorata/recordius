import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/Wordmark";
import { ShareView } from "./ShareView";
import { Avatar } from "@/components/ui";
import { HttpError, currentUser } from "@/lib/auth";
import { viewUrl } from "@/lib/blob";
import { appUrl } from "@/lib/env";
import { LinkLockedError, getVideoFor, videoExists } from "@/lib/videos";
import { LinkGate } from "@/components/LinkGate";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const { video } = await getVideoFor(id, await currentUser());
    const url = `${appUrl()}/share/${id}`;
    return {
      title: video.title,
      description: `${video.owner.name} shared a video with Recordius`,
      robots: { index: false },
      openGraph: {
        title: video.title,
        description: `Watch ${video.owner.name}'s video`,
        url,
        type: "video.other",
        images: video.thumbUrl ? [{ url: video.thumbUrl, width: 1280, height: 720 }] : [{ url: `${appUrl()}/og-base.png`, width: 1200, height: 630 }],
        // No og:video for trimmed videos: link previews would play the uncut file.
        videos: video.videoUrl && video.privacy === "link" && !video.trim ? [{ url: video.videoUrl, type: video.mimeType.split(";")[0] }] : undefined,
      },
      twitter: { card: video.thumbUrl ? "summary_large_image" : "summary", title: video.title },
    };
  } catch {
    return { title: "Video", robots: { index: false } };
  }
}

export default async function SharePage({ params }: Props) {
  const { id } = await params;
  const user = await currentUser();
  let result: Awaited<ReturnType<typeof getVideoFor>>;
  try {
    result = await getVideoFor(id, user);
  } catch (err) {
    if (err instanceof LinkLockedError) return <LinkGate videoId={id} reason={err.reason} />;
    if (err instanceof HttpError && err.status === 401) redirect(`/login?next=${encodeURIComponent(`/share/${id}`)}`);
    if (err instanceof HttpError && err.status === 403) return <NoAccess exists={await videoExists(id)} userEmail={user?.email ?? null} />;
    return <NoAccess exists={false} userEmail={user?.email ?? null} />;
  }
  const { video, access } = result;
  const avatarUrl = user?.avatarPath ? await viewUrl(user.avatarPath) : null;

  return (
    <div className="min-h-dvh bg-bg">
      <header className="mx-auto flex max-w-[1180px] items-center justify-between px-4 py-4 sm:px-6">
        <Link href={user ? "/library" : "/"} className="text-ink" aria-label="Recordius">
          <Wordmark className="h-[22px]" />
        </Link>
        {user ? (
          <Link href="/library" className="flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm font-medium hover:bg-surface-2">
            <Avatar name={user.name} url={avatarUrl} size={28} />
            My library
          </Link>
        ) : (
          <Link href={`/login?next=${encodeURIComponent(`/share/${id}`)}`} className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-2 hover:bg-surface-2">
            Sign in
          </Link>
        )}
      </header>
      <main className="mx-auto max-w-[1180px] px-4 pb-20 sm:px-6">
        <ShareView initial={video} access={access} shareUrl={`${appUrl()}/share/${id}`} viewerId={user?.id ?? null} />
      </main>
    </div>
  );
}

function NoAccess({ exists, userEmail }: { exists: boolean; userEmail: string | null }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 text-center">
      <div className="flex max-w-md flex-col items-center gap-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/mascot-512.png" alt="" className="h-28 w-auto" />
        <Wordmark className="h-6 text-ink" />
        {exists ? (
          <>
            <h1 className="text-xl font-semibold">This video is private</h1>
            <p className="text-sm text-ink-3">
              You’re signed in as <b>{userEmail}</b>, but that address wasn’t given access. Ask the owner to share it with you, or sign in with a different account.
            </p>
            <form action="/api/auth/logout" method="post">
              <Link href="/login" className="text-sm font-medium text-accent hover:underline">
                Switch account
              </Link>
            </form>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">We couldn’t find that video</h1>
            <p className="text-sm text-ink-3">The link may be incomplete, or the video was deleted.</p>
          </>
        )}
      </div>
    </main>
  );
}
