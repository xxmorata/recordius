"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, Scissors } from "lucide-react";
import { Button, cx } from "./ui";
import { formatDuration } from "@/lib/format";

type Props = {
  src: string;
  poster?: string | null;
  /** Length of the whole file, ms. */
  totalMs: number;
  initial: { startMs: number; endMs: number } | null;
  onCancel: () => void;
  onSave: (trim: { startMs: number; endMs: number } | null) => Promise<void>;
};

const MIN_MS = 1000;

/**
 * Non-destructive trim: the owner picks start and end on the full timeline; only the two numbers are saved.
 * The preview shows the frame under the handle being dragged, and "Play selection" plays the kept part.
 */
export function TrimEditor({ src, poster, totalMs, initial, onCancel, onSave }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState(initial?.startMs ?? 0);
  const [end, setEnd] = useState(initial?.endMs ?? totalMs);
  const [playhead, setPlayhead] = useState(initial?.startMs ?? 0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState<"start" | "end" | null>(null);
  const range = useRef({ start, end });
  range.current = { start, end };

  const pct = (ms: number) => `${(ms / totalMs) * 100}%`;

  function show(ms: number) {
    const v = video.current;
    if (v) v.currentTime = ms / 1000;
    setPlayhead(ms);
  }

  function msAt(clientX: number) {
    const rect = track.current!.getBoundingClientRect();
    return Math.round((Math.min(Math.max(0, clientX - rect.left), rect.width) / rect.width) * totalMs);
  }

  function startDrag(which: "start" | "end", e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    video.current?.pause();
    setDrag(which);
    const move = (ev: PointerEvent) => {
      const ms = msAt(ev.clientX);
      if (which === "start") {
        const next = Math.min(ms, range.current.end - MIN_MS);
        setStart(Math.max(0, next));
        show(Math.max(0, next));
      } else {
        const next = Math.max(ms, range.current.start + MIN_MS);
        setEnd(Math.min(totalMs, next));
        show(Math.min(totalMs, next));
      }
    };
    const up = () => {
      setDrag(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Clicking the track moves the playhead (inside the selection) for a closer look.
  function clickTrack(e: React.PointerEvent) {
    const ms = msAt(e.clientX);
    show(Math.min(Math.max(ms, start), end));
  }

  // Play only the selection; stop at its end.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (!v) return;
      const ms = v.currentTime * 1000;
      setPlayhead(ms);
      if (ms >= range.current.end - 20) {
        v.pause();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  function togglePlay() {
    const v = video.current;
    if (!v) return;
    if (!v.paused) return v.pause();
    if (v.currentTime * 1000 < start || v.currentTime * 1000 >= end - 50) v.currentTime = start / 1000;
    v.play().catch(() => {});
  }

  // Arrow keys nudge the handle that was used last (1 s, or 0.1 s with Shift).
  const lastHandle = useRef<"start" | "end">("start");
  useEffect(() => {
    if (drag) lastHandle.current = drag;
  }, [drag]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      e.stopPropagation();
      const step = (e.shiftKey ? 100 : 1000) * (e.key === "ArrowLeft" ? -1 : 1);
      if (lastHandle.current === "start") {
        const next = Math.max(0, Math.min(range.current.start + step, range.current.end - MIN_MS));
        setStart(next);
        show(next);
      } else {
        const next = Math.min(totalMs, Math.max(range.current.end + step, range.current.start + MIN_MS));
        setEnd(next);
        show(next);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [totalMs]);

  const unchanged = start === (initial?.startMs ?? 0) && end === (initial?.endMs ?? totalMs);
  const full = start <= 0 && end >= totalMs;

  return (
    <div className="flex flex-col gap-4">
      {/* Leave room for the timeline below: the preview never pushes it off screen. */}
      <div className="relative mx-auto aspect-video w-full max-w-[min(100%,calc((100dvh-380px)*16/9))] overflow-hidden rounded-2xl bg-black">
        <video
          ref={video}
          src={src}
          poster={poster ?? undefined}
          crossOrigin="anonymous"
          playsInline
          preload="auto"
          className="size-full"
          onLoadedMetadata={(e) => (e.currentTarget.currentTime = start / 1000)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
        <span className="absolute top-3 left-3 flex items-center gap-1.5 rounded-lg bg-ink/80 px-2.5 py-1 text-xs font-medium text-white">
          <Scissors className="size-3.5" /> Trimming
        </span>
      </div>

      <div className="card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={togglePlay} icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />}>
              {playing ? "Pause" : "Play selection"}
            </Button>
            <p className="text-sm text-ink-2 tabular-nums">
              <span className="font-medium text-ink">{formatDuration(end - start)}</span>
              <span className="text-ink-3"> of {formatDuration(totalMs)}</span>
            </p>
          </div>
          <p className="text-[13px] text-ink-3">Drag the handles · arrow keys nudge by 1 s (Shift: 0.1 s)</p>
        </div>

        <div
          ref={track}
          onPointerDown={clickTrack}
          className="relative mt-5 mb-2 h-14 cursor-pointer touch-none rounded-xl bg-surface-2 select-none"
          role="group"
          aria-label="Trim range"
        >
          {/* removed parts */}
          <div className="absolute inset-y-0 left-0 rounded-l-xl bg-ink/10" style={{ width: pct(start) }} />
          <div className="absolute inset-y-0 right-0 rounded-r-xl bg-ink/10" style={{ width: `calc(100% - ${pct(end)})` }} />
          {/* kept part */}
          <div className="absolute inset-y-0 border-y-[3px] border-accent bg-accent/10" style={{ left: pct(start), right: `calc(100% - ${pct(end)})` }} />
          {/* playhead */}
          <div className="pointer-events-none absolute inset-y-1 w-0.5 rounded bg-brand" style={{ left: pct(playhead) }} />
          <Handle side="start" at={pct(start)} active={drag === "start"} label={formatDuration(start)} onPointerDown={(e) => startDrag("start", e)} />
          <Handle side="end" at={pct(end)} active={drag === "end"} label={formatDuration(end)} onPointerDown={(e) => startDrag("end", e)} />
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-ink-3">Nothing is deleted — viewers only see the selection, and you can undo this anytime. Download keeps the full file.</p>
          <div className="flex gap-2">
            {!full && (
              <Button
                variant="ghost"
                onClick={() => {
                  setStart(0);
                  setEnd(totalMs);
                  show(0);
                }}
              >
                Reset
              </Button>
            )}
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              loading={saving}
              disabled={unchanged}
              onClick={async () => {
                setSaving(true);
                await onSave(full ? null : { startMs: start, endMs: end });
                setSaving(false);
              }}
            >
              Save trim
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Handle({ side, at, active, label, onPointerDown }: { side: "start" | "end"; at: string; active: boolean; label: string; onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      className={cx("absolute inset-y-0 z-10 flex w-4 cursor-ew-resize items-center justify-center rounded-md bg-accent shadow transition-transform", side === "start" ? "-translate-x-full" : "", active && "scale-y-110")}
      style={{ left: at }}
      role="slider"
      aria-label={side === "start" ? "Trim start" : "Trim end"}
      aria-valuetext={label}
    >
      <span className="h-5 w-0.5 rounded bg-white/90" />
      <span className={cx("pointer-events-none absolute -top-7 rounded bg-ink px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums", active ? "opacity-100" : "opacity-0")}>{label}</span>
    </div>
  );
}
