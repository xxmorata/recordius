"use client";

import Link from "next/link";
import { useState } from "react";
import { Laptop, Trash2 } from "lucide-react";
import { Button, EmptyState, api } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { formatRelative } from "@/lib/format";

type Device = { id: string; name: string; createdAt: number; lastUsedAt: number | null };

export function DevicesList({ initial }: { initial: Device[] }) {
  const { toast } = useToast();
  const [devices, setDevices] = useState(initial);

  async function disconnect(d: Device) {
    try {
      await api(`/api/devices/${d.id}`, { method: "DELETE" });
      setDevices((all) => all.filter((x) => x.id !== d.id));
      toast("Device disconnected");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <section className="card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Connected devices</h2>
          <p className="mt-0.5 text-sm text-ink-3">Desktop apps signed in to your account. Disconnect any you don’t recognise.</p>
        </div>
        <Link href="/download">
          <Button variant="secondary" size="sm">
            Connect a Mac
          </Button>
        </Link>
      </div>
      {devices.length === 0 ? (
        <div className="mt-5">
          <EmptyState icon={<Laptop />} title="No devices yet" text="Install Recordius for Mac and connect it from the download page." />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-3">
              <span className="grid size-9 place-items-center rounded-lg bg-surface-2 text-ink-2">
                <Laptop className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{d.name}</p>
                <p className="text-[13px] text-ink-3">
                  Connected {formatRelative(d.createdAt)}
                  {d.lastUsedAt ? ` · last used ${formatRelative(d.lastUsedAt)}` : " · not used yet"}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => disconnect(d)} icon={<Trash2 className="size-4" />}>
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
