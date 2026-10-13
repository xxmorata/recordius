"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { ApiError, Avatar, Button, Spinner, api, cx } from "./ui";
import { useToast } from "./Toast";
import { formatDuration, formatRelative } from "@/lib/format";
import type { Comment } from "@/lib/types";

type Props = {
  videoId: string;
  /** Current player position on the (trimmed) timeline, seconds. */
  position: number;
  onSeek: (seconds: number) => void;
  onChange?: (comments: Comment[]) => void;
};

/** Timestamped comments, visible only to people in the workspace (and invited guests). */
export function Comments({ videoId, position, onSeek, onChange }: Props) {
  const { toast } = useToast();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [hidden, setHidden] = useState(false); // no access (signed out, removed): the rest of the page still works
  const [loadFailed, setLoadFailed] = useState(false);
  const [body, setBody] = useState("");
  const [atTime, setAtTime] = useState(true);
  const [sending, setSending] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  /** Background refreshes keep the current list on a hiccup (offline, deploy); only a lost access hides the section. */
  async function load() {
    try {
      const r = await api<{ comments: Comment[] }>(`/api/videos/${videoId}/comments`);
      setComments(r.comments);
      setLoadFailed(false);
      changed.current?.(r.comments);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setHidden(true);
      else setLoadFailed(true);
    }
  }

  useEffect(() => {
    load();
    // Pick up teammates' comments while the page stays open.
    const t = setInterval(() => !document.hidden && load(), 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Grow the box with its text (up to a limit).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [body]);

  async function send() {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await api(`/api/videos/${videoId}/comments`, { method: "POST", json: { body: text, atMs: atTime ? Math.round(position * 1000) : null } });
      setBody("");
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSending(false);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/videos/${videoId}/comments/${id}`, { method: "DELETE" });
      setConfirmId(null);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  if (hidden) return null;

  return (
    <section className="card p-4 sm:p-5" aria-label="Comments">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">
          Comments{comments && comments.length > 0 && <span className="ml-1.5 text-ink-3 tabular-nums">{comments.length}</span>}
        </h2>
        <p className="text-[13px] text-ink-3">Only people in your workspace see these</p>
      </div>

      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={box}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder="Add a comment…"
          className="focus-ring block w-full resize-none rounded-xl border border-line-2 bg-surface px-3 py-2.5 text-sm placeholder:text-ink-4"
          aria-label="Comment"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2 select-none">
            <input type="checkbox" checked={atTime} onChange={(e) => setAtTime(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
            At <span className="font-medium tabular-nums">{formatDuration(position * 1000)}</span>
          </label>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-ink-4 sm:inline">⌘ Enter to send</span>
            <Button type="submit" size="sm" loading={sending} disabled={!body.trim()}>
              Comment
            </Button>
          </div>
        </div>
      </form>

      {!comments && loadFailed ? (
        <p className="mt-4 text-sm text-ink-3">
          Couldn’t load comments.{" "}
          <button type="button" onClick={load} className="font-medium text-accent hover:underline">
            Try again
          </button>
        </p>
      ) : !comments ? (
        <div className="grid place-items-center py-6">
          <Spinner />
        </div>
      ) : comments.length === 0 ? (
        <div className="mt-4 flex items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-3">
          <MessageSquare className="size-4 shrink-0" />
          No comments yet. Leave one at the moment you’re talking about — it shows up on the timeline.
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {comments.map((c) => (
            <li key={c.id} className="group flex gap-3 py-3">
              <Avatar name={c.author.name} url={c.author.avatarUrl} size={32} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 text-[13px]">
                  <span className="font-medium text-ink">{c.author.name}</span>
                  {c.atMs != null && (
                    <button
                      type="button"
                      onClick={() => onSeek(c.atMs! / 1000)}
                      className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-semibold text-accent tabular-nums hover:bg-accent hover:text-white"
                      title="Play from here"
                    >
                      {formatDuration(c.atMs)}
                    </button>
                  )}
                  <span className="text-ink-4">{formatRelative(c.createdAt)}</span>
                </p>
                <p className="mt-1 text-sm break-words whitespace-pre-wrap text-ink-2">{c.body}</p>
              </div>
              {c.canDelete && (
                <button
                  type="button"
                  onClick={() => (confirmId === c.id ? remove(c.id) : setConfirmId(c.id))}
                  onBlur={() => setConfirmId((id) => (id === c.id ? null : id))}
                  className={cx(
                    "h-7 shrink-0 self-start rounded-lg px-1.5 text-xs font-medium transition",
                    confirmId === c.id ? "bg-red-50 text-danger" : "text-ink-4 hover:bg-surface-2 hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100",
                  )}
                  aria-label={confirmId === c.id ? "Confirm delete" : "Delete comment"}
                >
                  {confirmId === c.id ? "Delete?" : <Trash2 className="size-4" />}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
