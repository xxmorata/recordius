"use client";

import { useState } from "react";
import { Check, Copy, Laptop } from "lucide-react";
import { Button, Input, api } from "@/components/ui";
import { useToast } from "@/components/Toast";

/** Creates a device token and opens recordius://connect; shows a copyable fallback for when the deep link doesn't open. */
export function ConnectButton() {
  const { toast } = useToast();
  const [link, setLink] = useState<{ deepLink: string; server: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function connect() {
    setBusy(true);
    try {
      const deviceName = `${navigator.platform.includes("Mac") ? "Mac" : "Computer"} · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
      const r = await api<{ deepLink: string; server: string; token: string }>("/api/desktop/connect", { method: "POST", json: { deviceName } });
      setLink(r);
      window.location.href = r.deepLink;
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const manual = link ? `${link.server} ${link.token}` : "";

  return (
    <div>
      <Button onClick={connect} loading={busy} icon={<Laptop className="size-4" />}>
        Connect desktop app
      </Button>
      {link && (
        <div className="animate-pop mt-4 rounded-xl bg-surface-2 p-4">
          <p className="text-sm font-medium">Recordius should open and sign in by itself.</p>
          <p className="mt-1 text-[13px] text-ink-3">
            Nothing happened? In the app choose <b>Paste connection code</b> and paste this (it works once and expires with the app’s token):
          </p>
          <div className="mt-2 flex gap-2">
            <Input readOnly value={manual} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(manual);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
