"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Archive, ChevronDown, Download, LogOut, Menu as MenuIcon, Settings, Users, Video, X } from "lucide-react";
import { Wordmark } from "./Wordmark";
import { Avatar, Menu, cx } from "./ui";

type Props = {
  user: { name: string; email: string; avatarUrl: string | null; role: string };
  workspace: string;
  counts: { mine: number; workspace: number; archive: number };
};

export function Sidebar({ user, workspace, counts }: Props) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const scope = search.get("scope") ?? "mine";

  const nav = [
    { href: "/library", label: "My videos", icon: <Video />, count: counts.mine, active: pathname === "/library" && scope === "mine" },
    { href: "/library?scope=workspace", label: "Workspace", icon: <Users />, count: counts.workspace, active: pathname === "/library" && scope === "workspace" },
    { href: "/library?scope=archive", label: "Archive", icon: <Archive />, count: counts.archive, active: pathname === "/library" && scope === "archive" },
  ];

  async function signOut() {
    await fetch("/api/auth/logout", { method: "post" });
    router.replace("/login");
    router.refresh();
  }

  const body = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pt-5 pb-4">
        <Link href="/library" className="text-ink" aria-label="Recordius home">
          <Wordmark className="h-5" />
        </Link>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-2 lg:hidden" aria-label="Close menu">
          <X className="size-5" />
        </button>
      </div>

      <div className="px-3">
        <Menu
          align="start"
          className="w-full"
          trigger={
            <button type="button" className="focus-ring flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-surface-2">
              <Avatar name={user.name} url={user.avatarUrl} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{workspace}</span>
                <span className="block truncate text-xs text-ink-3">{user.email}</span>
              </span>
              <ChevronDown className="size-4 text-ink-3" />
            </button>
          }
          items={[
            { label: "Settings", icon: <Settings />, onSelect: () => router.push("/settings") },
            { label: "Members & invites", icon: <Users />, onSelect: () => router.push("/settings/workspace") },
            "separator",
            { label: "Sign out", icon: <LogOut />, onSelect: signOut },
          ]}
        />
      </div>

      <nav className="mt-4 flex flex-col gap-0.5 px-3">
        <p className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-ink-4 uppercase">Library</p>
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={cx(
              "flex items-center gap-2.5 rounded-lg px-2 py-[7px] text-sm font-medium [&>svg]:size-[18px]",
              item.active ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            <span className={item.active ? "text-accent" : "text-ink-3"}>{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            <span className="text-xs tabular-nums text-ink-4">{item.count || ""}</span>
          </Link>
        ))}
        <p className="mt-5 px-2 pb-1 text-[11px] font-semibold tracking-wide text-ink-4 uppercase">Workspace</p>
        <Link
          href="/settings/workspace"
          onClick={() => setOpen(false)}
          className={cx("flex items-center gap-2.5 rounded-lg px-2 py-[7px] text-sm font-medium [&>svg]:size-[18px]", pathname.startsWith("/settings") ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}
        >
          <Settings className={pathname.startsWith("/settings") ? "text-accent" : "text-ink-3"} />
          Settings
        </Link>
      </nav>

      <div className="mt-auto p-3">
        <Link href="/download" onClick={() => setOpen(false)} className="card block p-3.5 transition hover:shadow-[var(--shadow-pop)]">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/mascot-128.png" alt="" className="h-11 w-auto" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">Recordius for Mac</p>
              <p className="text-xs text-ink-3">Record with one shortcut</p>
            </div>
          </div>
          <span className="mt-3 flex items-center justify-center gap-1.5 rounded-lg bg-ink py-1.5 text-xs font-medium text-white">
            <Download className="size-3.5" /> Get the app
          </span>
        </Link>
      </div>
    </div>
  );

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 lg:hidden">
        <button type="button" onClick={() => setOpen(true)} className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2" aria-label="Open menu">
          <MenuIcon className="size-5" />
        </button>
        <Wordmark className="h-5 text-ink" />
      </header>
      <aside className="sticky top-0 hidden h-dvh w-[260px] shrink-0 border-r border-line bg-surface lg:block">{body}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <aside className="animate-pop absolute inset-y-0 left-0 w-[280px] bg-surface shadow-[var(--shadow-pop)]">{body}</aside>
        </div>
      )}
    </>
  );
}
