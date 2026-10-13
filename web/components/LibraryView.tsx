"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DropZone, useUploads } from "./Uploads";
import { Archive, ArchiveRestore, Download, Eye, KeyRound, Upload, Link2, MoreHorizontal, Pencil, Play, Search, Share2, Trash2, Video as VideoIcon } from "lucide-react";
import { Avatar, Button, Dialog, EmptyState, Input, Menu, api, cx } from "./ui";
import { useToast } from "./Toast";
import { PrivacyIcon, ShareDialog } from "./ShareDialog";
import type { LibraryScope, Video } from "@/lib/types";
import { formatDuration, formatRelative, pluralize } from "@/lib/format";

type Props = { initial: Video[]; scope: LibraryScope; origin: string; userId: string; canManageAll: boolean };

const TITLES: Record<LibraryScope, { title: string; blurb: string }> = {
  mine: { title: "My videos", blurb: "Everything you’ve recorded." },
  workspace: { title: "Workspace", blurb: "Everything shared with the whole workspace, plus videos shared with you by email." },
  archive: { title: "Archive", blurb: "Archived videos keep their links and can be restored anytime." },
};

export function LibraryView({ initial, scope, origin, userId, canManageAll }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [videos, setVideos] = useState(initial);
  const [query, setQuery] = useState("");
  const [sharing, setSharing] = useState<Video | null>(null);
  const [renaming, setRenaming] = useState<Video | null>(null);
  const [deleting, setDeleting] = useState<Video | null>(null);
  const { upload } = useUploads();
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => setVideos(initial), [initial]);

  // While something is still uploading, keep the list fresh.
  useEffect(() => {
    if (!videos.some((v) => v.status === "recording")) return;
    const t = setInterval(async () => {
      const r = await api<{ videos: Video[] }>(`/api/videos?scope=${scope}`).catch(() => null);
      if (r) setVideos(r.videos);
    }, 3000);
    return () => clearInterval(t);
  }, [videos, scope]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? videos.filter((v) => v.title.toLowerCase().includes(q)) : videos), [videos, q]);

  function patchLocal(id: string, patch: Partial<Video>) {
    setVideos((all) => all.map((v) => (v.id === id ? { ...v, ...patch } : v)));
    setSharing((s) => (s && s.id === id ? { ...s, ...patch } : s));
  }

  async function update(v: Video, patch: { title?: string; privacy?: Video["privacy"]; archived?: boolean }, done: string) {
    try {
      await api(`/api/videos/${v.id}`, { method: "PATCH", json: patch });
      if (patch.archived !== undefined) setVideos((all) => all.filter((x) => x.id !== v.id));
      else patchLocal(v.id, patch);
      toast(done);
      router.refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function remove(v: Video) {
    setDeleting(null);
    try {
      await api(`/api/videos/${v.id}`, { method: "DELETE" });
      setVideos((all) => all.filter((x) => x.id !== v.id));
      toast("Video deleted");
      router.refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function copyLink(v: Video) {
    await navigator.clipboard.writeText(`${origin}/share/${v.id}`);
    toast("Link copied");
  }

  const meta = TITLES[scope];

  return (
    <>
      <DropZone />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[13px] font-medium text-ink-3">Library</p>
          <h1 className="text-[26px] font-semibold tracking-tight">{meta.title}</h1>
          <p className="mt-1 text-sm text-ink-3">{meta.blurb}</p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="video/mp4,video/quicktime,video/webm,video/x-m4v"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) upload(e.target.files);
              e.target.value = "";
            }}
          />
          <Button variant="secondary" icon={<Upload className="size-4" />} onClick={() => fileInput.current?.click()} title="Or drop video files anywhere on this page">
            Upload
          </Button>
          <Link href="/download">
            <Button icon={<VideoIcon className="size-4" />}>New video</Button>
          </Link>
        </div>
      </div>

      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search videos" className="pl-9" />
        </div>
        <p className="shrink-0 text-sm text-ink-3">{pluralize(shown.length, "video")}</p>
      </div>

      {shown.length === 0 ? (
        q ? (
          <EmptyState title={`No videos match “${query}”`} />
        ) : scope === "mine" ? (
          <EmptyState
            icon={<VideoIcon />}
            title="Record your first video"
            text="Install Recordius for Mac and press ⌘⇧R — the link is on your clipboard the moment you stop. Or drop an existing video file here."
            action={
              <Link href="/download">
                <Button>Get the desktop app</Button>
              </Link>
            }
          />
        ) : scope === "archive" ? (
          <EmptyState icon={<Archive />} title="Nothing archived" text="Archive a video from its menu to hide it from your library without deleting it." />
        ) : (
          <EmptyState icon={<Share2 />} title="Nothing shared yet" text="Videos set to “Workspace members” and videos shared with you by email show up here." />
        )
      ) : (
        <ul className="grid gap-x-5 gap-y-7 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((v) => {
            const own = v.owner.id === userId;
            const editable = own || canManageAll;
            return (
              <li key={v.id} className="group">
                <Link href={`/share/${v.id}`} className="relative block aspect-video overflow-hidden rounded-xl bg-ink shadow-[var(--shadow-card)]">
                  {v.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.thumbUrl} alt="" className="size-full object-cover transition group-hover:scale-[1.02]" />
                  ) : (
                    <div className="grid size-full place-items-center text-white/30">
                      <VideoIcon className="size-8" />
                    </div>
                  )}
                  <span className="absolute inset-0 grid place-items-center bg-ink/0 transition group-hover:bg-ink/20">
                    <span className="grid size-12 scale-90 place-items-center rounded-full bg-white/95 text-ink opacity-0 shadow transition group-hover:scale-100 group-hover:opacity-100">
                      <Play className="ml-0.5 size-5 fill-current" />
                    </span>
                  </span>
                  {v.status === "ready" ? (
                    v.durationMs != null && (
                      <span className="absolute right-2 bottom-2 rounded-md bg-ink/80 px-1.5 py-0.5 text-xs font-medium text-white tabular-nums">{formatDuration(v.durationMs)}</span>
                    )
                  ) : v.status === "failed" ? (
                    <span className="absolute top-2 left-2 rounded-md bg-ink/80 px-1.5 py-0.5 text-xs font-medium text-white">Upload failed</span>
                  ) : (
                    <span className="absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-ink/80 px-1.5 py-0.5 text-xs font-medium text-white">
                      <span className="animate-rec size-1.5 rounded-full bg-brand" /> Uploading
                    </span>
                  )}
                </Link>

                <div className="mt-3 flex items-start gap-3">
                  <Avatar name={v.owner.name} url={v.owner.avatarUrl} size={32} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <Link href={`/share/${v.id}`} className="line-clamp-2 text-[15px] leading-snug font-semibold hover:underline" title={v.title}>
                      {v.title}
                    </Link>
                    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[13px] text-ink-3">
                      <span>{own ? "You" : v.owner.name}</span>
                      <span aria-hidden>·</span>
                      <span>{formatRelative(v.createdAt)}</span>
                      <span aria-hidden>·</span>
                      <span className="inline-flex items-center gap-1">
                        <Eye className="size-3.5" /> {v.views}
                      </span>
                      <span aria-hidden>·</span>
                      <PrivacyIcon privacy={v.privacy} className="inline-block size-3.5" />
                      {v.privacy === "link" && v.link.hasPassword && <KeyRound className="size-3.5" aria-label="Password protected" />}
                      {v.privacy === "link" && v.link.expiresAt !== null && v.link.expiresAt < Date.now() && <span className="text-danger">Link expired</span>}
                    </p>
                  </div>
                  <Menu
                    trigger={
                      <button type="button" className="focus-ring rounded-lg p-1.5 text-ink-4 transition hover:bg-surface-2 hover:text-ink" aria-label="More">
                        <MoreHorizontal className="size-5" />
                      </button>
                    }
                    items={[
                      { label: "Copy link", icon: <Link2 />, onSelect: () => copyLink(v) },
                      { label: "Share…", icon: <Share2 />, onSelect: () => setSharing(v) },
                      ...(v.downloadUrl ? [{ label: "Download", icon: <Download />, onSelect: () => window.open(v.downloadUrl!, "_blank") }] : []),
                      ...(editable
                        ? ([
                            "separator",
                            { label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(v) },
                            v.archived
                              ? { label: "Restore from archive", icon: <ArchiveRestore />, onSelect: () => update(v, { archived: false }, "Video restored") }
                              : { label: "Move to archive", icon: <Archive />, onSelect: () => update(v, { archived: true }, "Moved to archive") },
                            { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(v) },
                          ] as const)
                        : []),
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {sharing && (
        <ShareDialog
          video={sharing}
          shareUrl={`${origin}/share/${sharing.id}`}
          open
          onClose={() => setSharing(null)}
          onChange={(patch) => patchLocal(sharing.id, patch)}
          canEdit={sharing.owner.id === userId || canManageAll}
        />
      )}
      {renaming && (
        <RenameDialog
          title={renaming.title}
          onClose={() => setRenaming(null)}
          onSave={async (title) => {
            await update(renaming, { title }, "Title updated");
            setRenaming(null);
          }}
        />
      )}
      <Dialog open={Boolean(deleting)} onClose={() => setDeleting(null)} title="Delete this video?" width={420}>
        <p className="text-sm text-ink-2">
          <b>{deleting?.title}</b> will be permanently deleted, and its link will stop working. This can’t be undone.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => deleting && remove(deleting)}>
            Delete video
          </Button>
        </div>
      </Dialog>
    </>
  );
}

export function RenameDialog({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (title: string) => Promise<void> }) {
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} title="Rename video" width={440}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await onSave(value.trim());
          setBusy(false);
        }}
      >
        <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus maxLength={200} onFocus={(e) => e.currentTarget.select()} />
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!value.trim() || value.trim() === title}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export { cx };
