"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Check, Clock, Download, Eye, ImageIcon, Link2, MoreHorizontal, Pencil, Scissors, Share2, Trash2 } from "lucide-react";
import { Player, type PlayerHandle, type PlayerMarker } from "@/components/Player";
import { Comments } from "@/components/Comments";
import { TrimEditor } from "@/components/TrimEditor";
import { ViewersDialog } from "@/components/ViewersDialog";
import { useWatchReporting } from "@/components/useWatchReporting";
import { PrivacyIcon, ShareDialog } from "@/components/ShareDialog";
import { Avatar, Button, Dialog, Menu, api } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { PRIVACY_LABELS, type Access, type Comment, type Video } from "@/lib/types";
import { formatDate, formatDuration, formatStartTime, parseStartTime, pluralize } from "@/lib/format";

type Props = { initial: Video; access: Access; shareUrl: string; viewerId: string | null };

export function ShareView({ initial, access, shareUrl, viewerId }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [video, setVideo] = useState(initial);
  const [position, setPosition] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState<"link" | "time" | null>(null);
  const [startAt, setStartAt] = useState<number | null>(null);
  const [trimming, setTrimming] = useState(false);
  const [showViewers, setShowViewers] = useState(false);
  const [markers, setMarkers] = useState<PlayerMarker[]>([]);
  const player = useRef<PlayerHandle>(null);
  const canComment = access !== "link";
  const canEdit = access === "owner";
  const own = video.owner.id === viewerId;
  const watch = useWatchReporting(video.id, access !== "owner");

  useEffect(() => {
    setStartAt(parseStartTime(new URLSearchParams(window.location.search).get("t")));
  }, []);

  // Keep the tab title in step with renames.
  useEffect(() => {
    document.title = `${video.title} · Recordius`;
  }, [video.title]);

  // Like Loom, the link exists before the upload finishes: poll until it's ready. A failed upload can
  // still finish later (the Mac app retries from its local copy), so keep checking, just less often.
  useEffect(() => {
    if (video.status === "ready") return;
    const t = setInterval(async () => {
      if (document.hidden) return;
      const next = await api<Video>(`/api/videos/${video.id}`).catch(() => null);
      if (next && next.status !== video.status) setVideo(next);
    }, video.status === "recording" ? 2500 : 15000);
    return () => clearInterval(t);
  }, [video.id, video.status]);

  // Presigned URLs expire after a few hours; refresh them if the page stays open that long.
  useEffect(() => {
    if (video.status !== "ready") return;
    const t = setInterval(async () => {
      const next = await api<Video>(`/api/videos/${video.id}`).catch(() => null);
      if (next?.videoUrl) setVideo((v) => ({ ...v, videoUrl: next.videoUrl, downloadUrl: next.downloadUrl, thumbUrl: next.thumbUrl }));
    }, 4 * 60 * 60 * 1000);
    return () => clearInterval(t);
  }, [video.id, video.status]);

  async function copy(kind: "link" | "time") {
    await navigator.clipboard.writeText(kind === "link" ? shareUrl : `${shareUrl}?t=${formatStartTime(position)}`);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }

  async function saveTrim(trim: { startMs: number; endMs: number } | null) {
    try {
      await api(`/api/videos/${video.id}`, { method: "PATCH", json: { trim } });
      setVideo((v) => ({ ...v, trim, durationMs: trim ? trim.endMs - trim.startMs : v.originalDurationMs }));
      setTrimming(false);
      toast(trim ? "Trim saved — viewers now see the shorter version" : "Trim removed");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function useFrameAsThumbnail() {
    try {
      const jpeg = await player.current!.captureFrame();
      const form = new FormData();
      form.set("file", new File([jpeg], "thumb.jpg", { type: "image/jpeg" }));
      const r = await api<{ thumbUrl: string }>(`/api/videos/${video.id}/thumbnail`, { method: "POST", body: form });
      setVideo((v) => ({ ...v, thumbUrl: r.thumbUrl }));
      toast("Thumbnail updated");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function update(patch: { title?: string; privacy?: Video["privacy"]; archived?: boolean }, done: string) {
    try {
      await api(`/api/videos/${video.id}`, { method: "PATCH", json: patch });
      setVideo((v) => ({ ...v, ...patch }));
      toast(done);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function remove() {
    try {
      await api(`/api/videos/${video.id}`, { method: "DELETE" });
      router.replace("/library");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[min(100%,calc((100dvh-250px)*16/9))] flex-col gap-5">
      {video.status === "ready" && video.videoUrl && trimming && video.originalDurationMs ? (
        <TrimEditor
          src={video.videoUrl}
          poster={video.thumbUrl}
          totalMs={video.originalDurationMs}
          initial={video.trim}
          onCancel={() => setTrimming(false)}
          onSave={saveTrim}
        />
      ) : video.status === "ready" && video.videoUrl ? (
        <Player
          ref={player}
          key={`${video.videoUrl}`}
          src={video.videoUrl}
          poster={video.thumbUrl}
          trim={video.trim}
          startAt={startAt}
          autoPlay={!own}
          onTime={(s) => {
            setPosition(Math.floor(s));
            watch.onTime(s);
          }}
          onFirstPlay={watch.onFirstPlay}
          markers={markers}
          className="shadow-[0_20px_60px_-20px_rgba(25,28,38,0.45)]"
        />
      ) : (
        <Processing status={video.status} source={video.source} thumbUrl={video.thumbUrl} />
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <Title
            video={video}
            canEdit={canEdit}
            fresh={own && canEdit && video.source === "recording"}
            editing={renaming}
            setEditing={setRenaming}
            onSave={(title) => update({ title }, "Title updated")}
          />
          <div className="mt-3 flex items-center gap-3">
            <Avatar name={video.owner.name} url={video.owner.avatarUrl} size={40} />
            <div className="text-sm">
              <p className="font-medium">{video.owner.name}</p>
              <p className="flex flex-wrap items-center gap-x-1.5 text-ink-3">
                <span>{formatDate(video.createdAt)}</span>
                {video.durationMs != null && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{formatDuration(video.durationMs)}</span>
                  </>
                )}
                <span aria-hidden>·</span>
                {canEdit ? (
                  <button type="button" onClick={() => setShowViewers(true)} className="inline-flex items-center gap-1 rounded-md px-1 hover:bg-surface-2 hover:text-ink" title="See who watched">
                    <Eye className="size-3.5" /> {pluralize(video.views, "view")}
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Eye className="size-3.5" /> {pluralize(video.views, "view")}
                  </span>
                )}
                {canEdit && (
                  <>
                    <span aria-hidden>·</span>
                    <button type="button" onClick={() => setSharing(true)} className="inline-flex items-center gap-1 rounded-md px-1 hover:bg-surface-2 hover:text-ink">
                      <PrivacyIcon privacy={video.privacy} className="inline-block size-3.5" />
                      {PRIVACY_LABELS[video.privacy].title}
                    </button>
                  </>
                )}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => copy("link")} icon={copied === "link" ? <Check className="size-4" /> : <Link2 className="size-4" />}>
            {copied === "link" ? "Copied" : "Copy link"}
          </Button>
          <Button onClick={() => setSharing(true)} icon={<Share2 className="size-4" />}>
            Share
          </Button>
          <Menu
            trigger={
              <Button variant="secondary" aria-label="More" title="More" className="w-10 px-0!">
                <MoreHorizontal className="size-5" />
              </Button>
            }
            items={[
              { label: `Copy link at ${formatDuration(position * 1000)}`, icon: <Clock />, onSelect: () => copy("time") },
              ...(video.downloadUrl ? [{ label: "Download", icon: <Download />, onSelect: () => window.open(video.downloadUrl!, "_blank") }] : []),
              ...(canEdit
                ? ([
                    "separator",
                    { label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(true) },
                    ...(video.status === "ready" && video.originalDurationMs
                      ? [
                          { label: video.trim ? "Edit trim" : "Trim video", icon: <Scissors />, onSelect: () => setTrimming(true) },
                          { label: "Use this frame as thumbnail", icon: <ImageIcon />, onSelect: useFrameAsThumbnail, disabled: trimming },
                        ]
                      : []),
                    { label: "Viewers", icon: <Eye />, onSelect: () => setShowViewers(true) },
                    video.archived
                      ? { label: "Restore from archive", icon: <ArchiveRestore />, onSelect: () => update({ archived: false }, "Video restored") }
                      : { label: "Move to archive", icon: <Archive />, onSelect: () => update({ archived: true }, "Moved to archive") },
                    { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(true) },
                  ] as const)
                : []),
            ]}
          />
        </div>
      </div>

      {copied === "time" && <p className="text-sm text-success">Link copied — it starts at {formatDuration(position * 1000)}.</p>}

      {!viewerId && (
        <div className="mt-6 flex flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-6 text-center sm:flex-row sm:text-left">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/mascot-512.png" alt="" className="h-16 w-auto" />
          <div className="flex-1">
            <p className="font-semibold">Record and share videos like this one</p>
            <p className="text-sm text-ink-3">Recordius is open source and self-hosted: your team’s recordings stay on your own server.</p>
          </div>
          <Link href="https://github.com/xxmorata/recordius" className="shrink-0 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink-2">
            Get Recordius
          </Link>
        </div>
      )}

      {canComment && video.status === "ready" && (
        <Comments
          videoId={video.id}
          position={position}
          onSeek={(s) => player.current?.seekTo(s)}
          onChange={(list: Comment[]) =>
            setMarkers(list.filter((c) => c.atMs != null).map((c) => ({ id: c.id, seconds: c.atMs! / 1000, label: `${c.author.name}: ${c.body}` })))
          }
        />
      )}

      {showViewers && <ViewersDialog videoId={video.id} onClose={() => setShowViewers(false)} />}
      {sharing && <ShareDialog video={video} shareUrl={shareUrl} open onClose={() => setSharing(false)} onChange={(p) => setVideo((v) => ({ ...v, ...p }))} canEdit={canEdit} />}
      <Dialog open={deleting} onClose={() => setDeleting(false)} title="Delete this video?" width={420}>
        <p className="text-sm text-ink-2">It will be permanently deleted and this link will stop working. This can’t be undone.</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleting(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={remove}>
            Delete video
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function Processing({ status, source, thumbUrl }: { status: Video["status"]; source: Video["source"]; thumbUrl: string | null }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-ink shadow-[0_20px_60px_-20px_rgba(25,28,38,0.45)]">
      {thumbUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumbUrl} alt="" className="absolute inset-0 size-full object-cover opacity-40 blur-sm" />
      )}
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex flex-col items-center gap-3 text-center text-white">
          {status === "failed" ? (
            <>
              <p className="text-lg font-medium">This upload didn’t finish</p>
              <p className="max-w-xs text-sm text-white/70">
                {source === "upload"
                  ? "The file didn’t finish uploading. The owner can upload it again from their library."
                  : "The recording is saved on the owner’s Mac, and Recordius uploads it as soon as it can. This page updates by itself."}
              </p>
            </>
          ) : (
            <>
              <span className="relative flex size-4">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-75" />
                <span className="relative inline-flex size-4 rounded-full bg-brand" />
              </span>
              <p className="text-lg font-medium">{source === "upload" ? "Uploading…" : "Recording in progress"}</p>
              <p className="max-w-xs text-sm text-white/70">This page updates by itself — the video starts as soon as it has finished uploading.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const DEFAULT_TITLE = /^Recording [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M$/;
const FRESH_MS = 10 * 60 * 1000;

/**
 * The title, editable in place by the owner (click, Enter to save, Esc to cancel). Right after a
 * recording, while it still has its default name, the field opens focused so you can just type a name.
 */
function Title({ video, canEdit, fresh, editing, setEditing, onSave }: { video: Video; canEdit: boolean; fresh: boolean; editing: boolean; setEditing: (v: boolean) => void; onSave: (title: string) => Promise<void> }) {
  const [prompt, setPrompt] = useState(false);

  // Client-only (time and sessionStorage), once per video per tab.
  useEffect(() => {
    if (!fresh || !DEFAULT_TITLE.test(video.title) || Date.now() - video.createdAt > FRESH_MS) return;
    const key = `rcd-named-${video.id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {}
    setPrompt(true);
    setEditing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (canEdit && editing) {
    return (
      <TitleInput
        initial={video.title}
        hint={prompt ? "Give your video a name — Enter to save, Esc to keep this one." : "Enter to save · Esc to cancel"}
        onDone={async (next) => {
          if (next && next !== video.title) await onSave(next);
          setEditing(false);
          setPrompt(false);
        }}
      />
    );
  }
  return (
    <div className="flex items-start gap-2">
      {canEdit ? (
        <h1 className="min-w-0 text-xl font-semibold tracking-tight break-words sm:text-2xl">
          <button type="button" onClick={() => setEditing(true)} className="-mx-1 rounded-lg px-1 text-left hover:bg-surface-2" title="Click to rename">
            {video.title}
          </button>
        </h1>
      ) : (
        <h1 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">{video.title}</h1>
      )}
      {canEdit && (
        <button type="button" onClick={() => setEditing(true)} className="mt-1 shrink-0 rounded-lg p-1.5 text-ink-4 hover:bg-surface-2 hover:text-ink" aria-label="Rename">
          <Pencil className="size-4" />
        </button>
      )}
    </div>
  );
}

/** Mounted fresh for every edit: focused and selected before the first paint, so fast typing isn't lost. */
function TitleInput({ initial, hint, onDone }: { initial: string; hint: string; onDone: (title: string | null) => Promise<void> }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  function finish(title: string | null) {
    if (finished.current) return;
    finished.current = true;
    onDone(title);
  }

  return (
    <div>
      <input
        ref={input}
        value={value}
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(value.trim() || null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(value.trim() || null);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(null);
          }
        }}
        aria-label="Video title"
        className="-mx-2 w-[calc(100%+1rem)] rounded-lg border border-accent/40 bg-surface px-2 py-0.5 text-xl font-semibold tracking-tight outline-none ring-4 ring-accent/10 sm:text-2xl"
      />
      <p className="mt-1.5 text-[13px] text-ink-3">{hint}</p>
    </div>
  );
}
