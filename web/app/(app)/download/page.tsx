import Link from "next/link";
import { Apple, ExternalLink } from "lucide-react";
import { ConnectButton } from "./ConnectButton";
import { Kbd } from "@/components/ui";
import { requireUser } from "@/lib/auth";

export const metadata = { title: "Get the desktop app" };

const REPO = "https://github.com/xxmorata/recordius";

export default async function Download() {
  await requireUser();
  return (
    <div className="mx-auto max-w-2xl">
      <div className="card overflow-hidden">
        <div className="flex flex-col items-center gap-6 bg-gradient-to-br from-[#f6f4ff] to-[#fff0f0] px-6 py-10 text-center sm:flex-row sm:text-left">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/mascot-256.png" alt="" className="h-32 w-auto drop-shadow-xl" />
          <div>
            <h1 className="text-[26px] font-semibold tracking-tight">Recordius for Mac</h1>
            <p className="mt-2 text-ink-2">
              Record your screen and camera with one shortcut. The link is on your clipboard the moment you stop — the video uploads while you record.
            </p>
            <p className="mt-3 text-sm text-ink-3">
              Start/stop <Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>R</Kbd> · Pause <Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>P</Kbd>
            </p>
          </div>
        </div>
        <ol className="divide-y divide-line">
          <Step n={1} title="Download and install">
            <p className="text-sm text-ink-3">macOS 13 or newer, Apple Silicon and Intel.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={`${REPO}/releases/latest`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-ink px-4 text-sm font-medium text-white hover:bg-ink-2">
                <Apple className="size-4" /> Download for Mac <ExternalLink className="size-3.5 opacity-60" />
              </a>
            </div>
            <p className="mt-3 text-xs text-ink-4">
              The app isn’t notarized with Apple yet, so on first launch right-click the app and choose <b>Open</b>, then confirm. You only do this once.
            </p>
          </Step>
          <Step n={2} title="Connect it to this workspace">
            <p className="text-sm text-ink-3">Open Recordius on your Mac, then click below. Your browser hands the app a sign-in token — no password typing.</p>
            <div className="mt-3">
              <ConnectButton />
            </div>
          </Step>
          <Step n={3} title="Allow screen recording">
            <p className="text-sm text-ink-3">
              macOS asks once for Screen Recording (and Camera/Microphone). Turn Recordius on in System Settings; the app restarts itself when it sees the permission.
            </p>
          </Step>
        </ol>
      </div>
      <p className="mt-6 text-center text-sm text-ink-3">
        Prefer to build it yourself? The source is on{" "}
        <Link href={REPO} className="font-medium text-accent hover:underline" target="_blank">
          GitHub
        </Link>
        .
      </p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4 px-6 py-5">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent">{n}</span>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">{title}</h2>
        {children}
      </div>
    </li>
  );
}
