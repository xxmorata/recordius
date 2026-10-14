import type { Metadata } from "next";
import Link from "next/link";
import { EmbedPlayer } from "./EmbedPlayer";
import { HttpError, currentUser } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { LinkLockedError, getVideoFor } from "@/lib/videos";
import { LinkGate } from "@/components/LinkGate";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const { video } = await getVideoFor(id, await currentUser());
    return { title: video.title, robots: { index: false } };
  } catch {
    return { title: "Video", robots: { index: false } };
  }
}

/** Chrome-less player for <iframe> embeds. Same access rules as the share page. */
export default async function EmbedPage({ params }: Props) {
  const { id } = await params;
  try {
    const { video } = await getVideoFor(id, await currentUser());
    return <EmbedPlayer initial={video} shareUrl={`${appUrl()}/share/${id}`} />;
  } catch (err) {
    if (err instanceof LinkLockedError) {
      return (
        <div className="fixed inset-0 grid place-items-center bg-surface p-6">
          <LinkGate videoId={id} reason={err.reason} compact />
        </div>
      );
    }
    const needsLogin = err instanceof HttpError && err.status === 401;
    return (
      <div className="fixed inset-0 grid place-items-center bg-ink p-6 text-center text-white">
        <div>
          <p className="font-medium">{needsLogin ? "Sign in to watch this video" : "This video isn’t available"}</p>
          <Link href={`/share/${id}`} target="_blank" className="mt-2 inline-block text-sm text-white/70 underline">
            Open on Recordius
          </Link>
        </div>
      </div>
    );
  }
}
