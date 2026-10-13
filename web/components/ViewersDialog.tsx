"use client";

import { useEffect, useState } from "react";
import { Eye, UserRound, X } from "lucide-react";
import { Avatar, Dialog, Spinner, api } from "./ui";
import { formatRelative, pluralize } from "@/lib/format";
import type { ViewerStats } from "@/lib/types";

/** Owner-only: who watched and how far they got. */
export function ViewersDialog({ videoId, onClose }: { videoId: string; onClose: () => void }) {
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ViewerStats>(`/api/videos/${videoId}/viewers`).then(setStats, (err) => setError(err.message));
  }, [videoId]);

  return (
    <Dialog open onClose={onClose} width={460}>
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">Viewers</h2>
          <p className="mt-0.5 text-sm text-ink-3">{stats ? pluralize(stats.total, "person") + " watched this video" : "Who watched and how far they got"}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-2" aria-label="Close">
          <X className="size-5" />
        </button>
      </div>

      {error && <p className="mt-5 text-sm text-danger">{error}</p>}
      {!stats && !error && (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      )}
      {stats && stats.total === 0 && (
        <div className="mt-6 flex flex-col items-center rounded-xl bg-surface-2 px-6 py-10 text-center">
          <Eye className="size-8 text-ink-4" />
          <p className="mt-3 font-medium">No views yet</p>
          <p className="mt-1 text-sm text-ink-3">Share the link — views appear here as soon as someone presses play. Your own views aren’t counted.</p>
        </div>
      )}
      {stats && stats.total > 0 && (
        <ul className="mt-5 max-h-[60vh] divide-y divide-line overflow-y-auto">
          {stats.viewers.map((v) => (
            <li key={v.email} className="flex items-center gap-3 py-3">
              <Avatar name={v.name} url={v.avatarUrl} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{v.name}</p>
                <p className="text-[13px] text-ink-3">{formatRelative(v.lastSeenAt)}</p>
              </div>
              <Progress percent={v.percent} />
            </li>
          ))}
          {stats.anonymous.count > 0 && (
            <li className="flex items-center gap-3 py-3">
              <span className="grid size-9 place-items-center rounded-full bg-surface-2 text-ink-3">
                <UserRound className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{pluralize(stats.anonymous.count, "anonymous viewer")}</p>
                <p className="text-[13px] text-ink-3">Watched without signing in · average shown</p>
              </div>
              <Progress percent={stats.anonymous.avgPercent} />
            </li>
          )}
        </ul>
      )}
    </Dialog>
  );
}

function Progress({ percent }: { percent: number }) {
  return (
    <span className="flex w-28 shrink-0 items-center gap-2">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </span>
      <span className="w-9 text-right text-xs font-medium tabular-nums text-ink-2">{percent}%</span>
    </span>
  );
}
