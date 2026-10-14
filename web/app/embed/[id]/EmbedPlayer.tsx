"use client";

import { useEffect, useState } from "react";
import { Player } from "@/components/Player";
import { useWatchReporting } from "@/components/useWatchReporting";
import { api } from "@/components/ui";
import type { Video } from "@/lib/types";
import { parseStartTime } from "@/lib/format";

/** True once the address answers with data (a byte-range request), so switching to it is instant. */
async function warmUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { range: "bytes=0-1" }, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export function EmbedPlayer({ initial, shareUrl }: { initial: Video; shareUrl: string }) {
  const [video, setVideo] = useState(initial);
  const [startAt, setStartAt] = useState<number | null>(null);
  const watch = useWatchReporting(video.id, true);

  useEffect(() => setStartAt(parseStartTime(new URLSearchParams(window.location.search).get("t"))), []);

  useEffect(() => {
    if (video.status !== "recording") return;
    const t = setInterval(async () => {
      if (document.hidden) return; // embedded in a background tab or scrolled away in another app
      const next = await api<Video>(`/api/videos/${video.id}`).catch(() => null);
      if (next && next.status !== "recording") setVideo(next);
    }, 3000);
    return () => clearInterval(t);
  }, [video.id, video.status]);

  // Same as the share page: swap in the repaired file once the seek index is there.
  useEffect(() => {
    if (video.status !== "ready" || video.seekIndex !== "pending") return;
    const started = Date.now();
    let warmTries = 0;
    const t = setInterval(async () => {
      if (Date.now() - started > 15 * 60 * 1000) return; // also while the tab is in the background: it's cheap and it matters
      const next = await api<Video>(`/api/videos/${video.id}`).catch(() => null);
      if (!next || next.seekIndex === "pending") return;
      // Fetch the first bytes of the repaired file first: a brand-new file can take seconds to be served
      // (cold cache), and that wait belongs here, not in the player after the switch.
      // If the warm-up keeps failing (a strict proxy, say), switch anyway after a few tries: the player retries.
      warmTries++;
      if (next.videoUrl && warmTries < 5 && !(await warmUp(next.videoUrl))) return; // tried again on the next tick
      setVideo((v) => ({ ...v, videoUrl: next.videoUrl, downloadUrl: next.downloadUrl, size: next.size, seekIndex: next.seekIndex }));
    }, 4000);
    return () => clearInterval(t);
  }, [video.id, video.status, video.seekIndex]);

  return (
    <div className="fixed inset-0 bg-black">
      {video.status === "ready" && video.videoUrl ? (
        <Player
          src={video.videoUrl}
          poster={video.thumbUrl}
          startAt={startAt}
          trim={video.trim}
          knownDurationMs={video.originalDurationMs}
          seekIndex={video.seekIndex}
          className="h-full rounded-none"
          onTime={watch.onTime}
          onFirstPlay={watch.onFirstPlay}
        />
      ) : (
        <div className="grid size-full place-items-center text-sm text-white/70">{video.status === "failed" ? "This upload didn’t finish." : "This video is still uploading…"}</div>
      )}
      <a href={shareUrl} target="_blank" rel="noreferrer" className="absolute top-2 right-2 rounded-md bg-black/50 px-2 py-1 text-[11px] font-medium text-white/80 hover:text-white">
        Recordius
      </a>
    </div>
  );
}
