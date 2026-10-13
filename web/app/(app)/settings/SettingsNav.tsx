"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

// Short labels on phones, so all three tabs fit without scrolling.
const ITEMS = [
  { href: "/settings", label: "Profile", short: "Profile" },
  { href: "/settings/workspace", label: "Members & workspace", short: "Members" },
  { href: "/settings/devices", label: "Connected devices", short: "Devices" },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto lg:w-52 lg:flex-col">
      {ITEMS.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          className={cx("shrink-0 rounded-lg px-3 py-2 text-sm font-medium", pathname === i.href ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}
        >
          <span className="sm:hidden">{i.short}</span>
          <span className="hidden sm:inline">{i.label}</span>
        </Link>
      ))}
    </nav>
  );
}
