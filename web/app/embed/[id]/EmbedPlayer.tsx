"use client";

import { useEffect, useState } from "react";
import { Player } from "@/components/Player";
import { api } from "@/components/ui";
import type { Video } from "@/lib/types";
import { parseStartTime } from "@/lib/format";

export function EmbedPlayer({ initial, shareUrl }: { initial: Video; shareUrl: string }) {
  const [video, setVideo] = useState(initial);
  const [startAt, setStartAt] = useState<number | null>(null);

  useEffect(() => setStartAt(parseStartTime(new URLSearchParams(window.location.search).get("t"))), []);

  useEffect(() => {
    if (video.status !== "recording") return;
    const t = setInterval(async () => {
      const next = await api<Video>(`/api/videos/${video.id}`).catch(() => null);
      if (next && next.status !== "recording") setVideo(next);
    }, 3000);
    return () => clearInterval(t);
  }, [video.id, video.status]);

  return (
    <div className="fixed inset-0 bg-black">
      {video.status === "ready" && video.videoUrl ? (
        <Player
          src={video.videoUrl}
          poster={video.thumbUrl}
          startAt={startAt}
          className="h-full rounded-none"
          onFirstPlay={() => fetch(`/api/videos/${video.id}/view`, { method: "post" }).catch(() => {})}
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
