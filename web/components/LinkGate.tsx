"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Clock, Lock } from "lucide-react";
import { Button, Input, api } from "./ui";
import { Wordmark } from "./Wordmark";

/** Shown instead of the video when its link needs a password or has expired. */
export function LinkGate({ videoId, reason, compact = false }: { videoId: string; reason: "password" | "expired"; compact?: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/videos/${videoId}/unlock`, { method: "POST", json: { password } });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const body =
    reason === "expired" ? (
      <>
        <span className="grid size-12 place-items-center rounded-full bg-surface-2 text-ink-3">
          <Clock className="size-6" />
        </span>
        <h1 className="text-xl font-semibold">This link has expired</h1>
        <p className="max-w-sm text-sm text-ink-3">The person who shared this video set the link to stop working. Ask them for a new one.</p>
      </>
    ) : (
      <>
        <span className="grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
          <Lock className="size-6" />
        </span>
        <h1 className="text-xl font-semibold">This video is password protected</h1>
        <p className="max-w-sm text-sm text-ink-3">Enter the password you were given to watch it.</p>
        <form onSubmit={submit} className="mt-2 flex w-full max-w-sm flex-col gap-3">
          <Input type="password" autoFocus required placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <Button type="submit" size="lg" loading={busy} disabled={!password}>
            Watch video
          </Button>
        </form>
      </>
    );

  if (compact) return <div className="flex flex-col items-center gap-3 text-center">{body}</div>;
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 text-center">
      <div className="flex w-full max-w-md flex-col items-center gap-4">
        <Wordmark className="mb-2 h-6 text-ink" />
        <div className="card flex w-full flex-col items-center gap-3 px-6 py-8">{body}</div>
      </div>
    </main>
  );
}
