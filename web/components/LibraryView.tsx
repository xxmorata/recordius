"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DropZone, useUploads } from "./Uploads";
import { Archive, ArchiveRestore, Check, Clock, Download, Eye, KeyRound, Upload, Link2, MoreHorizontal, Pencil, Play, Search, Share2, Trash2, Video as VideoIcon, X } from "lucide-react";
import { Avatar, Button, Dialog, EmptyState, Input, Menu, Select, api, cx } from "./ui";
import { useToast } from "./Toast";
import { PrivacyIcon, ShareDialog } from "./ShareDialog";
import { PRIVACY_LABELS, type LibraryScope, type Privacy, type Video } from "@/lib/types";
import { formatDuration, formatRelative, pluralize } from "@/lib/format";

type Props = { initial: Video[]; scope: LibraryScope; origin: string; userId: string; canManageAll: boolean };

const TITLES: Record<LibraryScope, { title: string; blurb: string }> = {
  mine: { title: "My videos", blurb: "Everything you’ve recorded." },
  workspace: { title: "Workspace", blurb: "Everything shared with the whole workspace, plus videos shared with you by email." },
  archive: { title: "Archive", blurb: "Archived videos keep their links and can be restored anytime." },
};

const LIST_LIMIT = 500; // same as listVideos' default on the server

type Sort = "newest" | "oldest" | "views" | "title";
const SORTS: Record<Sort, string> = { newest: "Newest first", oldest: "Oldest first", views: "Most viewed", title: "Title A–Z" };
const SORT_KEY = "rcd-library-sort";

function readSort(): Sort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return v && v in SORTS ? (v as Sort) : "newest";
  } catch {
    return "newest";
  }
}

export function LibraryView({ initial, scope, origin, userId, canManageAll }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [videos, setVideos] = useState(initial);
  const [query, setQuery] = useState("");
  const [sharing, setSharing] = useState<Video | null>(null);
  const [renaming, setRenaming] = useState<Video | null>(null);
  const [deleting, setDeleting] = useState<Video | null>(null);
  const [sort, setSort] = useState<Sort>("newest");
  const [owner, setOwner] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const { upload } = useUploads();
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => setVideos(initial), [initial]);

  // While a recent upload is still in progress, keep the list fresh — every 3 s at first, then every 10 s,
  // never in a background tab, and not forever (a recording interrupted on someone's Mac can stay
  // "uploading" for hours until their app retries).
  const uploading = videos.some((v) => v.status === "recording" && Date.now() - v.createdAt < 3 * 60 * 60 * 1000);
  useEffect(() => {
    if (!uploading) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (Date.now() - started > 15 * 60 * 1000) return;
      if (!document.hidden) {
        const r = await api<{ videos: Video[] }>(`/api/videos?scope=${scope}`).catch(() => null);
        if (r) setVideos(r.videos);
      }
      timer = setTimeout(tick, Date.now() - started < 60 * 1000 ? 3000 : 10000);
    };
    timer = setTimeout(tick, 3000);
    return () => clearTimeout(timer);
  }, [uploading, scope]);

  useEffect(() => setSort(readSort()), []);
  function changeSort(next: Sort) {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {}
  }

  const owners = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of videos) map.set(v.owner.id, v.owner.id === userId ? "You" : v.owner.name);
    return [...map].sort((a, b) => (a[0] === userId ? -1 : b[0] === userId ? 1 : a[1].localeCompare(b[1])));
  }, [videos, userId]);

  const q = query.trim().toLowerCase();
  // The page loads the newest LIST_LIMIT videos; with more than that, search asks the server so older ones are found.
  const capped = videos.length >= LIST_LIMIT;
  const [remote, setRemote] = useState<Video[] | null>(null);
  useEffect(() => {
    if (!capped || !q) return setRemote(null);
    const t = setTimeout(async () => {
      const r = await api<{ videos: Video[] }>(`/api/videos?scope=${scope}&q=${encodeURIComponent(q)}`).catch(() => null);
      if (r) setRemote(r.videos);
    }, 300);
    return () => clearTimeout(t);
  }, [capped, q, scope]);

  const shown = useMemo(() => {
    const list = (remote ?? videos).filter((v) => (!q || v.title.toLowerCase().includes(q)) && (owner === "all" || v.owner.id === owner));
    const by: Record<Sort, (a: Video, b: Video) => number> = {
      newest: (a, b) => b.createdAt - a.createdAt,
      oldest: (a, b) => a.createdAt - b.createdAt,
      views: (a, b) => b.views - a.views || b.createdAt - a.createdAt,
      title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }),
    };
    return list.sort(by[sort]);
  }, [videos, remote, q, owner, sort]);

  const isEditable = (v: Video) => v.owner.id === userId || canManageAll;
  // Selection only ever holds videos that are on screen and editable.
  const selectable = useMemo(() => shown.filter(isEditable), [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = useMemo(() => selectable.filter((v) => selected.has(v.id)), [selectable, selected]);
  const selecting = picked.length > 0;
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("dialog[open]") && setSelected(new Set());
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selecting]);

  function toggleSelected(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Runs one request per video (a few at a time) and reports how many worked. */
  async function bulk(kind: "archive" | "restore" | "privacy" | "delete", privacy?: Privacy) {
    const targets = picked;
    if (!targets.length) return;
    setBulkBusy(true);
    const ok: string[] = [];
    let firstError: string | null = null;
    const queue = [...targets];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let v = queue.shift(); v; v = queue.shift()) {
          try {
            if (kind === "delete") await api(`/api/videos/${v.id}`, { method: "DELETE" });
            else await api(`/api/videos/${v.id}`, { method: "PATCH", json: kind === "privacy" ? { privacy } : { archived: kind === "archive" } });
            ok.push(v.id);
          } catch (err) {
            firstError ??= (err as Error).message;
          }
        }
      }),
    );
    const done = new Set(ok);
    if (kind === "privacy") setVideos((all) => all.map((v) => (done.has(v.id) ? { ...v, privacy: privacy! } : v)));
    else setVideos((all) => all.filter((v) => !done.has(v.id)));
    setSelected(new Set([...targets.filter((v) => !done.has(v.id)).map((v) => v.id)]));
    setBulkBusy(false);
    setBulkDeleting(false);
    const verb = { archive: "Archived", restore: "Restored", privacy: "Updated", delete: "Deleted" }[kind];
    if (firstError) toast(`${verb} ${ok.length} of ${targets.length}. ${firstError}`, "error");
    else toast(`${verb} ${pluralize(ok.length, "video")}`);
    router.refresh();
  }

  function patchLocal(id: string, patch: Partial<Video>) {
    setVideos((all) => all.map((v) => (v.id === id ? { ...v, ...patch } : v)));
    setSharing((s) => (s && s.id === id ? { ...s, ...patch } : s));
  }

  /** Saves a change; returns false (and says why) when the server refused it. */
  async function update(v: Video, patch: { title?: string; privacy?: Video["privacy"]; archived?: boolean }, done: string): Promise<boolean> {
    try {
      await api(`/api/videos/${v.id}`, { method: "PATCH", json: patch });
      if (patch.archived !== undefined) setVideos((all) => all.filter((x) => x.id !== v.id));
      else patchLocal(v.id, patch);
      toast(done);
      // Only archive/privacy change the sidebar counts; a rename is already shown locally.
      if (patch.archived !== undefined || patch.privacy !== undefined) router.refresh();
      return true;
    } catch (err) {
      toast((err as Error).message, "error");
      return false;
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

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search videos" className="pl-9" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {scope !== "mine" && owners.length > 1 && (
            <Select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Filter by owner" className="h-9 w-auto min-w-36">
              <option value="all">Everyone</option>
              {owners.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          )}
          <Select value={sort} onChange={(e) => changeSort(e.target.value as Sort)} aria-label="Sort" className="h-9 w-auto min-w-36">
            {Object.entries(SORTS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          <p className="shrink-0 pl-1 text-sm text-ink-3" title={capped && !q ? "Only the newest videos are listed — search to find older ones" : undefined}>
            {capped && !q ? `Newest ${LIST_LIMIT} videos` : pluralize(shown.length, "video")}
          </p>
        </div>
      </div>

      {shown.length === 0 ? (
        q || owner !== "all" ? (
          <EmptyState title={q ? `No videos match “${query}”` : "No videos from this person here"} />
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
            const editable = isEditable(v);
            const isPicked = selected.has(v.id) && editable;
            return (
              <li key={v.id} className="group relative">
                {editable && (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isPicked}
                    aria-label={`Select “${v.title}”`}
                    onClick={() => toggleSelected(v.id)}
                    className={cx(
                      "focus-ring absolute top-2 left-2 z-10 grid size-6 place-items-center rounded-md border-2 shadow-sm transition",
                      isPicked ? "border-accent bg-accent text-white" : "border-white/90 bg-ink/30 text-transparent hover:bg-ink/50",
                      selecting || isPicked ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100",
                    )}
                  >
                    <Check className="size-4" strokeWidth={3} />
                  </button>
                )}
                <Link
                  href={`/share/${v.id}`}
                  onClick={(e) => {
                    // While picking videos, a click on a card selects it instead of opening it.
                    if (selecting && editable) {
                      e.preventDefault();
                      toggleSelected(v.id);
                    }
                  }}
                  className={cx("relative block aspect-video overflow-hidden rounded-xl bg-ink shadow-[var(--shadow-card)]", isPicked && "ring-3 ring-accent ring-offset-2 ring-offset-bg")}
                >
                  {v.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.thumbUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover transition group-hover:scale-[1.02]" />
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
                    <span className="absolute top-2 right-2 rounded-md bg-ink/80 px-1.5 py-0.5 text-xs font-medium text-white">Upload failed</span>
                  ) : (
                    <span className="absolute top-2 right-2 flex items-center gap-1.5 rounded-md bg-ink/80 px-1.5 py-0.5 text-xs font-medium text-white">
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
                      <span title={PRIVACY_LABELS[v.privacy].title} className="inline-flex">
                        <PrivacyIcon privacy={v.privacy} className="inline-block size-3.5" />
                      </span>
                      {v.privacy === "link" && v.link.hasPassword && (
                        <span title="Password protected" className="inline-flex">
                          <KeyRound className="size-3.5" aria-label="Password protected" />
                        </span>
                      )}
                      {v.privacy === "link" && v.link.expiresAt !== null &&
                        (v.link.expiresAt < Date.now() ? (
                          <span className="text-danger">Link expired</span>
                        ) : (
                          <span title={`Link expires in ${pluralize(Math.max(1, Math.ceil((v.link.expiresAt - Date.now()) / 864e5)), "day")}`} className="inline-flex" suppressHydrationWarning>
                            <Clock className="size-3.5" aria-label="Link expires" />
                          </span>
                        ))}
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
                      ...(v.canDownload ? [{ label: "Download", icon: <Download />, onSelect: () => window.open(`/api/videos/${v.id}/download`, "_blank") }] : []),
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

      {selecting && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4 lg:left-[260px]">
          <div role="toolbar" aria-label="Selected videos" className="animate-pop pointer-events-auto flex max-w-full flex-wrap items-center gap-1 rounded-2xl bg-ink p-1.5 pl-3 text-white shadow-[var(--shadow-pop)]">
            <span className="mr-1 text-sm font-medium tabular-nums">{picked.length} selected</span>
            {picked.length < selectable.length && (
              <button type="button" onClick={() => setSelected(new Set(selectable.map((v) => v.id)))} className="rounded-lg px-2.5 py-1.5 text-sm text-white/80 hover:bg-white/10 hover:text-white">
                Select all {selectable.length}
              </button>
            )}
            <span className="mx-1 hidden h-5 w-px bg-white/20 sm:block" aria-hidden />
            {scope !== "archive" && (
              <Menu
                align="start"
                trigger={
                  <button type="button" disabled={bulkBusy} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-white/10 disabled:opacity-50">
                    <Share2 className="size-4" /> Access
                  </button>
                }
                items={(Object.keys(PRIVACY_LABELS) as Privacy[]).map((p) => ({
                  label: PRIVACY_LABELS[p].title,
                  icon: <PrivacyIcon privacy={p} className="block size-4" />,
                  onSelect: () => bulk("privacy", p),
                }))}
              />
            )}
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => bulk(scope === "archive" ? "restore" : "archive")}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-white/10 disabled:opacity-50"
            >
              {scope === "archive" ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              {scope === "archive" ? "Restore" : "Archive"}
            </button>
            <button type="button" disabled={bulkBusy} onClick={() => setBulkDeleting(true)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-red-300 hover:bg-white/10 disabled:opacity-50">
              <Trash2 className="size-4" /> Delete
            </button>
            <button type="button" onClick={() => setSelected(new Set())} className="rounded-lg p-1.5 text-white/70 hover:bg-white/10 hover:text-white" aria-label="Clear selection (Esc)" title="Clear selection (Esc)">
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}
      <Dialog open={bulkDeleting} onClose={() => !bulkBusy && setBulkDeleting(false)} title={`Delete ${pluralize(picked.length, "video")}?`} width={420}>
        <p className="text-sm text-ink-2">They will be permanently deleted, and their links will stop working. This can’t be undone.</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" disabled={bulkBusy} onClick={() => setBulkDeleting(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={bulkBusy} onClick={() => bulk("delete")}>
            Delete {pluralize(picked.length, "video")}
          </Button>
        </div>
      </Dialog>

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
            if (await update(renaming, { title }, "Title updated")) setRenaming(null); // keep the dialog (and text) on failure
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
