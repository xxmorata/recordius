"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

const ITEMS = [
  { href: "/settings", label: "Profile" },
  { href: "/settings/workspace", label: "Members & workspace" },
  { href: "/settings/devices", label: "Connected devices" },
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
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
