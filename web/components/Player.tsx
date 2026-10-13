"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Maximize, Minimize, Pause, PictureInPicture2, Play, Volume2, VolumeX } from "lucide-react";
import { cx } from "./ui";
import { formatDuration } from "@/lib/format";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

type Props = {
  src: string;
  poster?: string | null;
  startAt?: number | null;
  autoPlay?: boolean;
  onFirstPlay?: () => void;
  onTime?: (seconds: number) => void;
  className?: string;
};

/** Loom-style player: custom controls, keyboard shortcuts, speed, PiP, fullscreen, scrubbing with preview time. */
export function Player({ src, poster, startAt, autoPlay, onFirstPlay, onTime, className }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const played = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [visible, setVisible] = useState(true);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [pipAvailable, setPipAvailable] = useState(false);

  useEffect(() => setPipAvailable("pictureInPictureEnabled" in document && document.pictureInPictureEnabled), []);

  const poke = useCallback(() => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 2600);
  }, []);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const toggle = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused || v.ended) v.play().catch(() => {});
    else v.pause();
  }, []);

  const seek = useCallback((t: number) => {
    const v = video.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(Math.max(0, t), v.duration);
    setTime(v.currentTime);
  }, []);

  function toggleFullscreen() {
    const el = root.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  }

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Keyboard shortcuts while the player (or page body) has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return;
      const v = video.current;
      if (!v) return;
      const key = e.key.toLowerCase();
      if (key === " " || key === "k") {
        e.preventDefault();
        toggle();
      } else if (key === "arrowleft" || key === "j") seek(v.currentTime - (key === "j" ? 10 : 5));
      else if (key === "arrowright" || key === "l") seek(v.currentTime + (key === "l" ? 10 : 5));
      else if (key === "m") v.muted = !v.muted;
      else if (key === "f") toggleFullscreen();
      else if (key === "arrowup" || key === "arrowdown") {
        e.preventDefault();
        v.volume = Math.min(1, Math.max(0, v.volume + (key === "arrowup" ? 0.1 : -0.1)));
        v.muted = false;
      } else if (/^[0-9]$/.test(key) && Number.isFinite(v.duration)) seek((Number(key) / 10) * v.duration);
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
    e.preventDefault();
    const v = video.current!;
    const wasPlaying = !v.paused;
    setScrubbing(true);
    seek(barTime(e.clientX));
    const move = (ev: PointerEvent) => seek(barTime(ev.clientX));
    const up = (ev: PointerEvent) => {
      seek(barTime(ev.clientX));
      setScrubbing(false);
      if (wasPlaying) v.play().catch(() => {});
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    if (wasPlaying) v.pause();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const progress = duration ? (time / duration) * 100 : 0;
  const bufferedPct = duration ? (buffered / duration) * 100 : 0;
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
        playsInline
        preload="metadata"
        autoPlay={autoPlay}
        className="size-full"
        onClick={toggle}
        onDoubleClick={toggleFullscreen}
        onPlay={() => {
          setPlaying(true);
          setEnded(false);
          poke();
          if (!played.current) {
            played.current = true;
            onFirstPlay?.();
          }
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setEnded(true)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setDuration(v.duration);
          v.playbackRate = speed;
          if (startAt != null && startAt > 0 && startAt < v.duration) v.currentTime = startAt;
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => {
          if (!scrubbing) setTime(e.currentTarget.currentTime);
          onTime?.(e.currentTarget.currentTime);
        }}
        onProgress={(e) => {
          const v = e.currentTarget;
          for (let i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) >= v.currentTime) setBuffered(v.buffered.end(i));
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
            <Play className="ml-1 size-7 fill-current" />
          </span>
        </button>
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
          className="group/bar relative mb-1 flex h-5 cursor-pointer items-center"
          onPointerDown={startScrub}
          onPointerMove={(e) => duration && setHover({ x: e.clientX - bar.current!.getBoundingClientRect().left, t: barTime(e.clientX) })}
          onPointerLeave={() => setHover(null)}
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
          {hover && (
            <span className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded bg-ink px-1.5 py-0.5 text-xs tabular-nums" style={{ left: hover.x }}>
              {formatDuration(hover.t * 1000)}
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
    </div>
  );
}

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
