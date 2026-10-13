"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Link2, UploadCloud, X } from "lucide-react";
import { api, cx } from "./ui";
import { uploadThumbnail, uploadVideoFile } from "@/lib/upload-client";
import type { UploadGrant } from "@/lib/storage/types";
import { useToast } from "./Toast";

type Item = {
  key: number;
  name: string;
  progress: number; // 0..100
  state: "preparing" | "uploading" | "done" | "error" | "cancelled";
  error?: string;
  shareUrl?: string;
  abort: AbortController;
};

type Ctx = { upload: (files: FileList | File[]) => void };
const UploadContext = createContext<Ctx>({ upload: () => {} });
export const useUploads = () => useContext(UploadContext);

const MAX_BYTES = 20 * 1024 ** 3;
const PLAYABLE = /^video\/(mp4|quicktime|webm|x-m4v)$/;

type Created = { id: string; shareUrl: string; upload: UploadGrant };

/** Reads duration and grabs a poster frame locally, before anything is uploaded. */
function inspect(file: File): Promise<{ durationMs: number; thumb: Blob | null }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
      URL.revokeObjectURL(url);
    };
    const timer = setTimeout(() => done(() => reject(new Error("This file took too long to open"))), 20000);
    v.onerror = () => done(() => reject(new Error("Your browser can’t play this file. Export it as MP4 (H.264) and try again.")));
    v.onloadedmetadata = () => {
      if (!Number.isFinite(v.duration) || v.duration <= 0) return done(() => reject(new Error("Couldn’t read the length of this video")));
      v.currentTime = Math.min(1, v.duration / 3);
    };
    v.onseeked = () => {
      const durationMs = Math.round(v.duration * 1000);
      try {
        const scale = Math.min(1, 1280 / (v.videoWidth || 1280));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round((v.videoWidth || 1280) * scale);
        canvas.height = Math.round((v.videoHeight || 720) * scale);
        canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((thumb) => done(() => resolve({ durationMs, thumb })), "image/jpeg", 0.85);
      } catch {
        done(() => resolve({ durationMs, thumb: null }));
      }
    };
    v.src = url;
  });
}

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { toast } = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const nextKey = useRef(1);
  const patch = (key: number, p: Partial<Item>) => setItems((all) => all.map((i) => (i.key === key ? { ...i, ...p } : i)));
  const busy = items.some((i) => i.state === "preparing" || i.state === "uploading");

  // Leaving the page would cut an upload off.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const one = useCallback(
    async (file: File) => {
      const key = nextKey.current++;
      const abort = new AbortController();
      setItems((all) => [...all, { key, name: file.name, progress: 0, state: "preparing", abort }]);
      let created: Created | null = null;
      try {
        if (!PLAYABLE.test(file.type)) throw new Error("Only MP4, MOV and WebM videos can be uploaded");
        if (file.size > MAX_BYTES) throw new Error("Videos must be smaller than 20 GB");
        const { durationMs, thumb } = await inspect(file);
        if (abort.signal.aborted) throw new DOMException("cancelled", "AbortError");
        // MOV/M4V with H.264 play everywhere when served as MP4.
        const mimeType = file.type === "video/webm" ? "video/webm" : "video/mp4";
        const title = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 200) || "Uploaded video";
        created = await api<Created>("/api/videos", { method: "POST", json: { title, mimeType, source: "upload" } });
        patch(key, { state: "uploading", shareUrl: created.shareUrl });
        router.refresh();
        if (thumb) {
          // A missing poster isn't worth failing the upload for.
          await uploadThumbnail(created.id, created.upload, thumb, abort.signal)
            .then(() => api(`/api/videos/${created!.id}/thumbnail`, { method: "POST" }))
            .catch((err) => {
              if (abort.signal.aborted) throw err;
            });
        }
        await uploadVideoFile(created.id, created.upload, file, mimeType, abort.signal, (f) => patch(key, { progress: Math.min(99, Math.round(f * 100)) }));
        await api(`/api/videos/${created.id}/complete`, { method: "POST", json: { durationMs, size: file.size } });
        patch(key, { state: "done", progress: 100 });
        router.refresh();
      } catch (err) {
        const cancelled = abort.signal.aborted || (err as Error).name === "AbortError";
        patch(key, { state: cancelled ? "cancelled" : "error", error: cancelled ? undefined : (err as Error).message });
        if (created) await api(`/api/videos/${created.id}`, { method: "DELETE" }).catch(() => {});
        if (!cancelled) toast((err as Error).message, "error");
        router.refresh();
      }
    },
    [router, toast],
  );

  const upload = useCallback(
    (files: FileList | File[]) => {
      for (const f of Array.from(files)) one(f);
    },
    [one],
  );

  return (
    <UploadContext.Provider value={{ upload }}>
      {children}
      {items.length > 0 && (
        <div className="fixed right-4 bottom-4 z-50 w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-2xl bg-surface shadow-[var(--shadow-pop)]">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="text-sm font-semibold">{busy ? "Uploading…" : "Uploads"}</p>
            {!busy && (
              <button type="button" onClick={() => setItems([])} className="rounded-lg p-1 text-ink-3 hover:bg-surface-2" aria-label="Close">
                <X className="size-4" />
              </button>
            )}
          </div>
          <ul className="max-h-72 divide-y divide-line overflow-y-auto">
            {items.map((i) => (
              <li key={i.key} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  {i.state === "done" ? (
                    <CheckCircle2 className="size-4 shrink-0 text-success" />
                  ) : i.state === "error" ? (
                    <CircleAlert className="size-4 shrink-0 text-danger" />
                  ) : (
                    <UploadCloud className="size-4 shrink-0 text-ink-3" />
                  )}
                  <p className="min-w-0 flex-1 truncate text-sm" title={i.name}>
                    {i.name}
                  </p>
                  {(i.state === "preparing" || i.state === "uploading") && (
                    <button type="button" onClick={() => i.abort.abort()} className="text-xs font-medium text-ink-3 hover:text-danger">
                      Cancel
                    </button>
                  )}
                  {i.state === "done" && i.shareUrl && (
                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(i.shareUrl!);
                        toast("Link copied");
                      }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                    >
                      <Link2 className="size-3.5" /> Copy link
                    </button>
                  )}
                </div>
                {(i.state === "preparing" || i.state === "uploading") && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div className={cx("h-full rounded-full bg-accent transition-[width]", i.state === "preparing" && "animate-pulse")} style={{ width: `${i.state === "preparing" ? 4 : Math.max(4, i.progress)}%` }} />
                  </div>
                )}
                {i.state === "error" && <p className="mt-1 text-xs text-danger">{i.error}</p>}
                {i.state === "cancelled" && <p className="mt-1 text-xs text-ink-3">Cancelled</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </UploadContext.Provider>
  );
}

/** Full-window drop target; renders an overlay while a file is dragged over the page. */
export function DropZone() {
  const { upload } = useUploads();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    };
    const overFn = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      if (e.dataTransfer?.files.length) upload(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", overFn);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [upload]);
  if (!over) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-accent/10 p-6 backdrop-blur-[2px]">
      <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-accent bg-surface/95 px-12 py-10 text-center shadow-[var(--shadow-pop)]">
        <UploadCloud className="size-10 text-accent" />
        <p className="text-lg font-semibold">Drop to upload</p>
        <p className="text-sm text-ink-3">MP4, MOV or WebM — it gets a share link like any recording.</p>
      </div>
    </div>
  );
}
