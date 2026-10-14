"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Keyboard, Loader2, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, Volume2, VolumeX, X } from "lucide-react";
import { cx } from "./ui";
import { formatDuration } from "@/lib/format";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

export type PlayerHandle = {
  /** JPEG of the frame on screen (max 1280 px wide). */
  captureFrame: () => Promise<Blob>;
  /** Position on the (trimmed) timeline, in seconds. */
  currentTime: () => number;
  /** Jump to a position on the (trimmed) timeline and play from there. */
  seekTo: (seconds: number) => void;
};

/** A point on the timeline, e.g. a comment. */
export type PlayerMarker = { id: string; seconds: number; label: string };

type Props = {
  src: string;
  poster?: string | null;
  /** Start position in seconds on the trimmed timeline (e.g. from ?t=). */
  startAt?: number | null;
  /** Only this part of the file is played; times shown are relative to its start. */
  trim?: { startMs: number; endMs: number } | null;
  autoPlay?: boolean;
  onFirstPlay?: () => void;
  /** Seconds on the trimmed timeline, on every time update. */
  onTime?: (seconds: number) => void;
  markers?: PlayerMarker[];
  /** The recording's length as the server knows it (ms). Used when the file doesn't say (see fileLength). */
  knownDurationMs?: number | null;
  /**
   * Whether the file has a seek index (see lib/mp4-index). "pending": the server is adding one; the page
   * swaps `src` for the repaired file when it's done and the player carries on where it was.
   */
  seekIndex?: "pending" | "ready" | "failed" | null;
  className?: string;
};

/**
 * Recordings made before desktop 1.0.14 are fragmented MP4 without a total duration: Firefox reports only
 * the first chunk ("0:00") and the number grows while playing. When the file's own length is missing or far
 * shorter than what the server recorded, trust the server.
 */
function fileLength(fileDuration: number, knownMs: number | null | undefined): number {
  const file = Number.isFinite(fileDuration) && fileDuration > 0 ? fileDuration : 0;
  const known = knownMs && knownMs > 0 ? knownMs / 1000 : 0;
  return known && (!file || file < known * 0.8) ? known : file;
}

const SHORTCUTS: Array<[string, string]> = [
  ["Space / K", "Play or pause"],
  ["← / →", "Back / forward 5 seconds"],
  ["J / L", "Back / forward 10 seconds"],
  ["↑ / ↓", "Volume up / down"],
  ["M", "Mute"],
  ["F", "Full screen"],
  ["< / >", "Slower / faster"],
  ["0 – 9", "Jump to 0% – 90%"],
  ["?", "Show these shortcuts"],
];

/**
 * Loom-style player: custom controls, keyboard shortcuts, speed, PiP, fullscreen, scrubbing with preview time.
 * Everything the viewer sees works on a "virtual" timeline that starts at the trim start and ends at the
 * trim end, so a trimmed video looks and behaves exactly like a shorter one.
 */
export const Player = forwardRef<PlayerHandle, Props>(function Player({ src, poster, startAt, trim, autoPlay, onFirstPlay, onTime, markers, knownDurationMs, seekIndex, className }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const played = useRef(false);
  const startApplied = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(0); // virtual seconds
  const [fileDuration, setFileDuration] = useState(0);
  const [buffered, setBuffered] = useState(0); // virtual seconds
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [visible, setVisible] = useState(true);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [pipAvailable, setPipAvailable] = useState(false);
  const [help, setHelp] = useState(false);
  // The browser couldn't reach the time the viewer asked for (a recording without a seek index, see
  // seekIndex): what we tell them, and where to go once the repaired file arrives.
  const [unseekable, setUnseekable] = useState<string | null>(null);
  const seekTarget = useRef<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  // Position to restore after `src` changes (expired URL refreshed, or the repaired file). The element
  // resets to 0 the moment React sets the new src, so the last known position and state are tracked
  // continuously instead of read at that point.
  const resumeAt = useRef<{ time: number; playing: boolean } | null>(null);
  const loadedSrc = useRef<string | null>(null);
  const lastPos = useRef(0); // virtual seconds
  const wasPlaying = useRef(false);
  const reloads = useRef(0);

  const base = trim ? trim.startMs / 1000 : 0;
  const length = fileLength(fileDuration, knownDurationMs);
  const end = trim ? Math.min(trim.endMs / 1000, length || Infinity) : length;
  const duration = Math.max(0, end - base);
  const bounds = useRef({ base, end, duration });
  bounds.current = { base, end, duration };

  useEffect(() => setPipAvailable("pictureInPictureEnabled" in document && document.pictureInPictureEnabled), []);

  useImperativeHandle(ref, () => ({
    currentTime: () => Math.max(0, (video.current?.currentTime ?? 0) - bounds.current.base),
    seekTo: (seconds: number) => {
      const v = video.current;
      if (!v) return;
      seek(seconds);
      v.play().catch(() => {});
      root.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    captureFrame: () =>
      new Promise<Blob>((resolve, reject) => {
        const v = video.current;
        if (!v || !v.videoWidth) return reject(new Error("The video isn't ready yet"));
        const scale = Math.min(1, 1280 / v.videoWidth);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't grab the frame"))), "image/jpeg", 0.86);
      }),
  }));

  const poke = useCallback(() => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 2600);
  }, []);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  /** Seek on the virtual timeline. */
  const seek = useCallback((t: number) => {
    const v = video.current;
    const { base, duration } = bounds.current;
    if (!v || !duration) return;
    const clamped = Math.min(Math.max(0, t), Math.max(0, duration - 0.05));
    seekTarget.current = clamped;
    lastPos.current = clamped;
    v.currentTime = base + clamped;
    setTime(clamped);
    setEnded(false);
    setUnseekable(null);
  }, []);

  /**
   * After a seek: if the browser stopped far short of the target although the recording is longer, the
   * file has no seek index for this browser (Firefox with recordings made before desktop 1.0.14).
   */
  const checkSeekLanded = useCallback(() => {
    const v = video.current;
    const target = seekTarget.current;
    seekTarget.current = null;
    if (!v || target == null) return;
    const { base, duration } = bounds.current;
    const landed = v.currentTime - base;
    if (target <= v.duration - base + 1 || Math.abs(landed - target) < 1 || duration <= v.duration - base + 1) return;
    // The playhead shows where the video really is, not where the click was; the jump happens once it can.
    pendingSeek.current = target;
    lastPos.current = Math.max(0, landed);
    setTime(Math.max(0, landed));
    const at = formatDuration(target * 1000);
    setUnseekable(
      seekIndex === "pending"
        ? `This browser can't skip ahead in this recording yet — it's being prepared; it will jump to ${at} in a moment…`
        : `This browser can't skip ahead in this recording. Try Chrome or Safari, or let it play to ${at}.`,
    );
  }, [seekIndex]);

  // A new address for the same video (refreshed link, or the file repaired with a seek index): keep the
  // viewer's place instead of starting over, and finish the jump they asked for if one is waiting.
  // Captured during render, i.e. before the element gets the new src: on that change it resets to 0 and
  // fires a last timeupdate, which an effect would see too late.
  if (loadedSrc.current !== null && loadedSrc.current !== src && !resumeAt.current) {
    resumeAt.current = { time: pendingSeek.current ?? lastPos.current, playing: wasPlaying.current };
  }
  useEffect(() => {
    if (loadedSrc.current === src) return;
    const first = loadedSrc.current === null;
    loadedSrc.current = src;
    if (first) return;
    pendingSeek.current = null;
    reloads.current = 0;
    setUnseekable(null);
    setWaiting(true); // until the new address plays (canplay / playing)
  }, [src]);

  const toggle = useCallback(() => {
    const v = video.current;
    if (!v) return;
    const { base, end } = bounds.current;
    if (v.paused || v.ended) {
      // Replay from the (trimmed) start once the end was reached.
      if (v.ended || v.currentTime >= end - 0.05 || v.currentTime < base) v.currentTime = base;
      v.play().catch(() => {});
    } else v.pause();
  }, []);

  // Stop exactly at the trim end (timeupdate alone fires only ~4×/s and would overshoot).
  useEffect(() => {
    if (!playing || !trim) return;
    let raf = 0;
    const check = () => {
      const v = video.current;
      const { end } = bounds.current;
      if (v && end && v.currentTime >= end - 0.02) {
        v.pause();
        v.currentTime = end;
        setTime(bounds.current.duration);
        setEnded(true);
        return;
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [playing, trim]);

  function toggleFullscreen() {
    const el = root.current;
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!el || !v) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
    else v.webkitEnterFullscreen?.(); // iPhone: only the video itself can go full screen
  }

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // A new trim (owner just saved one) moves the playhead into the kept part.
  useEffect(() => {
    const v = video.current;
    if (!v || !fileDuration) return;
    if (v.currentTime < base || v.currentTime > end) {
      v.currentTime = base;
      setTime(0);
    }
  }, [base, end, fileDuration]);

  // Keyboard shortcuts while the player (or page body) has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) && e.key === " ") return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser shortcuts (⌘L, ⌘F…) alone
      const v = video.current;
      if (!v) return;
      const now = v.currentTime - bounds.current.base;
      const key = e.key.toLowerCase();
      if (key === "?") {
        e.preventDefault();
        setHelp((h) => !h);
        return;
      }
      if (key === "escape") {
        setHelp(false);
        return;
      }
      if (key === " " || key === "k") {
        e.preventDefault();
        toggle();
      } else if (key === "arrowleft" || key === "j") seek(now - (key === "j" ? 10 : 5));
      else if (key === "arrowright" || key === "l") seek(now + (key === "l" ? 10 : 5));
      else if (key === "m") v.muted = !v.muted;
      else if (key === "f") toggleFullscreen();
      else if (key === "arrowup" || key === "arrowdown") {
        e.preventDefault();
        v.volume = Math.min(1, Math.max(0, v.volume + (key === "arrowup" ? 0.1 : -0.1)));
        v.muted = false;
      } else if (/^[0-9]$/.test(key) && bounds.current.duration) seek((Number(key) / 10) * bounds.current.duration);
      else if (key === ">" || key === "<") {
        const i = SPEEDS.indexOf(v.playbackRate);
        const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + (key === ">" ? 1 : -1)))];
        v.playbackRate = next;
        setSpeed(next);
      } else return;
      poke();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle, seek, poke]);

  function barTime(clientX: number) {
    const rect = bar.current!.getBoundingClientRect();
    return (Math.min(Math.max(0, clientX - rect.left), rect.width) / rect.width) * duration;
  }

  function startScrub(e: React.PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    const v = video.current!;
    const el = bar.current!;
    const wasPlaying = !v.paused && !v.ended;
    setScrubbing(true);
    seek(barTime(e.clientX));
    // Pointer capture: the drag keeps working outside the bar and even outside the window, and always ends.
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      seek(barTime(ev.clientX));
      setHover({ x: ev.clientX - el.getBoundingClientRect().left, t: barTime(ev.clientX) });
    };
    const finish = (ev: PointerEvent, cancelled: boolean) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!cancelled) seek(barTime(ev.clientX));
      setScrubbing(false);
      if (ev.pointerType !== "mouse") setHover(null);
      if (wasPlaying) v.play().catch(() => {});
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {}
    };
    const up = (ev: PointerEvent) => finish(ev, false);
    const cancel = (ev: PointerEvent) => finish(ev, true);
    if (wasPlaying) v.pause();
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
  }

  const progress = duration ? (time / duration) * 100 : 0;
  const bufferedPct = duration ? Math.min(100, (buffered / duration) * 100) : 0;
  const controlsShown = visible || !playing || scrubbing;

  return (
    <div
      ref={root}
      className={cx("group/player relative aspect-video w-full overflow-hidden bg-black text-white select-none", fullscreen ? "" : "rounded-2xl", className)}
      onMouseMove={poke}
      onMouseLeave={() => playing && setVisible(false)}
      onTouchStart={poke}
      tabIndex={0}
    >
      <video
        ref={video}
        src={src}
        poster={poster ?? undefined}
        crossOrigin="anonymous"
        playsInline
        preload="metadata"
        autoPlay={autoPlay}
        className="size-full"
        onClick={toggle}
        onDoubleClick={toggleFullscreen}
        onPlay={() => {
          setPlaying(true);
          setEnded(false);
          wasPlaying.current = true;
          poke();
          if (!played.current) {
            played.current = true;
            onFirstPlay?.();
          }
        }}
        onPause={() => {
          setPlaying(false);
          wasPlaying.current = false;
        }}
        onEnded={() => {
          setEnded(true);
          setPlaying(false);
          wasPlaying.current = false;
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        // A jump into a part that isn't downloaded yet takes a moment: show it (paused videos get no "waiting").
        onSeeking={() => setWaiting(true)}
        onSeeked={() => {
          setWaiting(false);
          checkSeekLanded();
        }}
        onError={(e) => {
          setWaiting(false);
          // A file that was swapped in a moment ago may not be served everywhere yet: try again shortly.
          const v = e.currentTarget;
          if (resumeAt.current && reloads.current < 4) {
            reloads.current++;
            setTimeout(() => v.load(), 2500);
          }
        }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setFileDuration(v.duration);
          v.playbackRate = speed;
          const resume = resumeAt.current;
          if (resume) {
            resumeAt.current = null;
            seek(resume.time);
            if (resume.playing) v.play().catch(() => {});
            return;
          }
          if (startApplied.current) return;
          startApplied.current = true;
          const b = trim ? trim.startMs / 1000 : 0;
          const full = fileLength(v.duration, knownDurationMs);
          const len = (trim ? Math.min(trim.endMs / 1000, full) : full) - b;
          const offset = startAt != null && startAt > 0 && startAt < len ? startAt : 0;
          if (b + offset > 0) v.currentTime = b + offset;
          // Tell the page where we start (timestamped comments, "copy link at…") before any playback.
          setTime(offset);
          onTime?.(offset);
        }}
        onDurationChange={(e) => setFileDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => {
          const t = Math.min(Math.max(0, e.currentTarget.currentTime - bounds.current.base), bounds.current.duration);
          if (!resumeAt.current) lastPos.current = t;
          if (!scrubbing) setTime(t);
          onTime?.(t);
        }}
        onProgress={(e) => {
          const v = e.currentTarget;
          for (let i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) >= v.currentTime) setBuffered(v.buffered.end(i) - bounds.current.base);
          }
        }}
        onVolumeChange={(e) => {
          setMuted(e.currentTarget.muted);
          setVolume(e.currentTarget.volume);
        }}
      />

      {/* center state */}
      {waiting && !ended && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Loader2 className="size-10 animate-spin text-white/90" />
        </div>
      )}
      {!playing && !waiting && (
        <button
          type="button"
          onClick={toggle}
          className="absolute inset-0 grid place-items-center"
          aria-label={ended ? "Replay" : "Play"}
        >
          <span className="grid size-[72px] place-items-center rounded-full bg-white/95 text-ink shadow-[0_8px_30px_rgba(0,0,0,0.35)] transition hover:scale-105">
            {ended ? <RotateCcw className="size-7" /> : <Play className="ml-1 size-7 fill-current" />}
          </span>
        </button>
      )}

      {unseekable && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
          <p className="pointer-events-auto max-w-md rounded-lg bg-ink/90 px-3 py-2 text-center text-[13px] text-white shadow-[var(--shadow-pop)]">
            {unseekable}
            {seekIndex === "pending" && <Loader2 className="ml-2 inline size-3.5 animate-spin align-[-2px]" />}
          </p>
        </div>
      )}

      {/* controls */}
      <div
        className={cx(
          "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-3 pt-10 pb-2 transition-opacity duration-200 sm:px-4",
          controlsShown ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div
          ref={bar}
          className="group/bar relative mb-1 flex h-5 cursor-pointer touch-none items-center"
          onPointerDown={startScrub}
          onPointerMove={(e) => duration && !scrubbing && setHover({ x: e.clientX - bar.current!.getBoundingClientRect().left, t: barTime(e.clientX) })}
          onPointerLeave={() => !scrubbing && setHover(null)}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
        >
          <div className="relative h-1 w-full rounded-full bg-white/30 transition-[height] group-hover/bar:h-1.5">
            <div className="absolute inset-y-0 left-0 rounded-full bg-white/40" style={{ width: `${bufferedPct}%` }} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${progress}%` }} />
            <div
              className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-brand shadow transition-transform group-hover/bar:scale-100"
              style={{ left: `${progress}%` }}
            />
          </div>
          {duration > 0 &&
            markers?.map((m) =>
              m.seconds <= duration ? (
                <span
                  key={m.id}
                  className="pointer-events-none absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-2 ring-accent"
                  style={{ left: `${(m.seconds / duration) * 100}%` }}
                />
              ) : null,
            )}
          {hover && (
            <span className="pointer-events-none absolute bottom-full mb-2 max-w-64 -translate-x-1/2 rounded bg-ink px-1.5 py-0.5 text-xs" style={{ left: Math.min(Math.max(hover.x, 40), (bar.current?.clientWidth ?? 0) - 40) }}>
              <span className="tabular-nums">{formatDuration(hover.t * 1000)}</span>
              {(() => {
                const near = duration ? markers?.find((m) => Math.abs(m.seconds - hover.t) <= duration * 0.012) : null;
                return near ? <span className="mt-0.5 block truncate text-white/80">{near.label}</span> : null;
              })()}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
          <Ctl onClick={toggle} label={playing ? "Pause (k)" : "Play (k)"}>
            {playing ? <Pause className="size-5 fill-current" /> : <Play className="size-5 fill-current" />}
          </Ctl>
          <div className="group/vol flex items-center">
            <Ctl
              onClick={() => {
                const v = video.current!;
                v.muted = !v.muted;
              }}
              label={muted ? "Unmute (m)" : "Mute (m)"}
            >
              {muted || volume === 0 ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
            </Ctl>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = video.current!;
                v.volume = Number(e.target.value);
                v.muted = v.volume === 0;
              }}
              className="rcd-range w-0 opacity-0 transition-all group-hover/vol:ml-1 group-hover/vol:w-20 group-hover/vol:opacity-100"
              style={{ ["--fill" as string]: `${(muted ? 0 : volume) * 100}%` }}
              aria-label="Volume"
            />
          </div>
          <span className="ml-1 text-[13px] tabular-nums text-white/90">
            {formatDuration(time * 1000)} <span className="text-white/50">/ {formatDuration(duration * 1000)}</span>
          </span>
          <div className="flex-1" />
          <span className="hidden sm:inline">
            <Ctl onClick={() => setHelp((h) => !h)} label="Keyboard shortcuts (?)">
              <Keyboard className="size-5" />
            </Ctl>
          </span>
          <SpeedMenu value={speed} onChange={(s) => { video.current!.playbackRate = s; setSpeed(s); }} />
          {pipAvailable && (
            <Ctl
              onClick={() => {
                const v = video.current!;
                if (document.pictureInPictureElement) document.exitPictureInPicture();
                else v.requestPictureInPicture?.().catch(() => {});
              }}
              label="Picture in picture"
            >
              <PictureInPicture2 className="size-5" />
            </Ctl>
          )}
          <Ctl onClick={toggleFullscreen} label={fullscreen ? "Exit full screen (f)" : "Full screen (f)"}>
            {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
          </Ctl>
        </div>
      </div>

      {help && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-black/70 p-4 backdrop-blur-[2px]" onClick={() => setHelp(false)}>
          <div className="animate-pop w-full max-w-sm rounded-2xl bg-ink/95 p-5 shadow-[var(--shadow-pop)]" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
            <div className="mb-3 flex items-center justify-between">
              <p className="font-semibold">Keyboard shortcuts</p>
              <button type="button" onClick={() => setHelp(false)} className="rounded-lg p-1 text-white/70 hover:bg-white/15 hover:text-white" aria-label="Close">
                <X className="size-4" />
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
              {SHORTCUTS.map(([keys, what]) => (
                <div key={keys} className="contents">
                  <dt>
                    <kbd className="rounded-md bg-white/15 px-1.5 py-0.5 font-sans text-xs font-medium whitespace-nowrap">{keys}</kbd>
                  </dt>
                  <dd className="text-white/80">{what}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
});

function Ctl({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="rounded-lg p-1.5 text-white/90 transition hover:bg-white/15 hover:text-white">
      {children}
    </button>
  );
}

function SpeedMenu({ value, onChange }: { value: number; onChange: (s: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="rounded-lg px-2 py-1.5 text-[13px] font-medium tabular-nums text-white/90 hover:bg-white/15" aria-label="Playback speed">
        {value}×
      </button>
      {open && (
        <div className="animate-pop absolute right-0 bottom-full mb-1 w-24 rounded-lg bg-ink/95 p-1 shadow-[var(--shadow-pop)]">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                onChange(s);
                setOpen(false);
              }}
              className={cx("block w-full rounded-md px-2 py-1 text-left text-[13px] tabular-nums hover:bg-white/15", s === value && "text-brand")}
            >
              {s}×{s === 1 ? " (normal)" : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
