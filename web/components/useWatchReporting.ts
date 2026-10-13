"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Reports watch progress for "who watched and how far": once when playback starts, then whenever the
 * furthest point grows by a few seconds, and one last time when the tab is hidden or closed.
 */
export function useWatchReporting(videoId: string, enabled: boolean) {
  const furthest = useRef(0);
  const sent = useRef(-1);
  const started = useRef(false);

  const send = useCallback(
    (beacon = false) => {
      if (!enabled || !started.current || furthest.current <= sent.current) return;
      sent.current = furthest.current;
      const body = JSON.stringify({ positionMs: Math.round(furthest.current * 1000) });
      const url = `/api/videos/${videoId}/view`;
      if (beacon && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
      else fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
    },
    [videoId, enabled],
  );

  useEffect(() => {
    if (!enabled) return;
    const flush = () => document.visibilityState === "hidden" && send(true);
    const leave = () => send(true);
    const timer = setInterval(() => furthest.current - sent.current >= 5 && send(), 5000);
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", leave);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", leave);
    };
  }, [enabled, send]);

  return {
    onFirstPlay: () => {
      if (!enabled || started.current) return;
      started.current = true;
      sent.current = -1;
      send();
    },
    onTime: (seconds: number) => {
      if (seconds > furthest.current) furthest.current = seconds;
    },
  };
}
