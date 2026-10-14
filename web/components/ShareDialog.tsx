"use client";

import { useEffect, useState } from "react";
import { Check, Clock, Code2, Copy, KeyRound, Link2, Lock, Users, X } from "lucide-react";
import { Button, Dialog, Input, Select, Switch, api, cx } from "./ui";
import { formatDate } from "@/lib/format";
import { useToast } from "./Toast";
import { PRIVACY_LABELS, type Privacy, type Video } from "@/lib/types";

const ICONS: Record<Privacy, React.ReactNode> = { link: <Link2 />, workspace: <Users />, private: <Lock /> };

export function PrivacyIcon({ privacy, className }: { privacy: Privacy; className?: string }) {
  return <span className={cx("[&>svg]:size-full", className)}>{ICONS[privacy]}</span>;
}

type Props = {
  video: Video;
  shareUrl: string;
  open: boolean;
  onClose: () => void;
  onChange: (patch: Partial<Video>) => void;
  canEdit: boolean;
};

export function ShareDialog({ video, shareUrl, open, onClose, onChange, canEdit }: Props) {
  const { toast } = useToast();
  const [emails, setEmails] = useState<string[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"link" | "embed" | null>(null);
  const embedUrl = shareUrl.replace("/share/", "/embed/");
  const embedCode = `<div style="position:relative;padding-bottom:56.25%;height:0"><iframe src="${embedUrl}" style="position:absolute;inset:0;width:100%;height:100%;border:0" allow="fullscreen; picture-in-picture" allowfullscreen></iframe></div>`;

  useEffect(() => {
    if (!open || !canEdit || video.privacy !== "private" || emails) return;
    api<{ emails: string[] }>(`/api/videos/${video.id}/access`).then((r) => setEmails(r.emails)).catch(() => setEmails([]));
  }, [open, canEdit, video.privacy, video.id, emails]);

  async function copy(kind: "link" | "embed") {
    await navigator.clipboard.writeText(kind === "link" ? shareUrl : embedCode);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }

  async function setPrivacy(privacy: Privacy) {
    if (privacy === video.privacy) return;
    try {
      await api(`/api/videos/${video.id}`, { method: "PATCH", json: { privacy } });
      onChange({ privacy });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function invite() {
    const value = email.trim();
    if (!value) return;
    setBusy(true);
    try {
      const r = await api<{ email: string }>(`/api/videos/${video.id}/access`, { method: "POST", json: { email: value } });
      setEmails((all) => (all?.includes(r.email) ? all : [...(all ?? []), r.email]));
      setEmail("");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(target: string) {
    setEmails((all) => all?.filter((e) => e !== target) ?? null);
    await api(`/api/videos/${video.id}/access`, { method: "DELETE", json: { email: target } }).catch(() => {});
  }

  return (
    <Dialog open={open} onClose={onClose} width={520}>
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">Share video</h2>
          <p className="mt-0.5 truncate text-sm text-ink-3">{video.title}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-2" aria-label="Close">
          <X className="size-5" />
        </button>
      </div>

      <div className="mt-5 flex gap-2">
        <Input readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[13px]" />
        <Button onClick={() => copy("link")} icon={copied === "link" ? <Check className="size-4" /> : <Copy className="size-4" />} className="w-32">
          {copied === "link" ? "Copied" : "Copy link"}
        </Button>
      </div>

      {canEdit && (
        <fieldset className="mt-5">
          <legend className="mb-2 text-[13px] font-medium text-ink-2">Who can watch</legend>
          <div className="overflow-hidden rounded-xl border border-line-2">
            {(Object.keys(PRIVACY_LABELS) as Privacy[]).map((key) => (
              <label key={key} className={cx("flex cursor-pointer items-start gap-3 px-3.5 py-3 not-last:border-b not-last:border-line", video.privacy === key && "bg-accent-soft/60")}>
                <input type="radio" name="privacy" className="sr-only" checked={video.privacy === key} onChange={() => setPrivacy(key)} />
                <span className={cx("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg [&>span>svg]:size-4", video.privacy === key ? "bg-accent text-white" : "bg-surface-2 text-ink-2")}>
                  <PrivacyIcon privacy={key} />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-medium">{PRIVACY_LABELS[key].title}</span>
                  <span className="block text-[13px] text-ink-3">{PRIVACY_LABELS[key].description}</span>
                </span>
                {video.privacy === key && <Check className="mt-1 size-4 text-accent" />}
              </label>
            ))}
          </div>

          {video.privacy === "link" && <LinkSettings video={video} onChange={onChange} />}

          {video.privacy === "private" && (
            <div className="mt-3 rounded-xl bg-surface-2 p-3">
              <p className="mb-2 text-[13px] font-medium text-ink-2">Invite people by email</p>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  invite();
                }}
              >
                <Input type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <Button type="submit" variant="secondary" loading={busy} disabled={!email.trim()}>
                  Invite
                </Button>
              </form>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {emails?.map((e) => (
                  <li key={e} className="flex items-center gap-1 rounded-full bg-surface py-1 pr-1 pl-2.5 text-[13px] shadow-[var(--shadow-card)]">
                    {e}
                    <button type="button" onClick={() => revoke(e)} className="rounded-full p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={`Remove ${e}`}>
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
                {emails && emails.length === 0 && <li className="text-[13px] text-ink-4">Nobody yet — only you can watch.</li>}
              </ul>
              <p className="mt-2 text-xs text-ink-4">Works for people who already have an account on this Recordius — for anyone else, use a password-protected link.</p>
            </div>
          )}
        </fieldset>
      )}

      <div className="mt-5 flex items-center justify-between rounded-xl border border-line-2 px-3.5 py-3">
        <span className="flex items-center gap-2.5 text-sm">
          <Code2 className="size-4 text-ink-3" />
          Embed on a website
        </span>
        <Button variant="secondary" size="sm" onClick={() => copy("embed")}>
          {copied === "embed" ? "Copied" : "Copy embed code"}
        </Button>
      </div>
      {video.privacy !== "link" && (
        <p className="mt-2 text-xs text-ink-4">Embeds follow the same access rules: viewers must be signed in on this Recordius.</p>
      )}
    </Dialog>
  );
}

const EXPIRY_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "1", label: "In 1 day" },
  { value: "7", label: "In 7 days" },
  { value: "30", label: "In 30 days" },
];

/** Password and expiry for "Anyone with the link". Workspace members are never asked for either. */
function LinkSettings({ video, onChange }: { video: Video; onChange: (patch: Partial<Video>) => void }) {
  const { toast } = useToast();
  const [editingPassword, setEditingPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const expired = video.link.expiresAt !== null && video.link.expiresAt < Date.now();

  async function save(patch: { linkPassword?: string | null; linkExpiresAt?: number | null }, done: string, local: Partial<Video["link"]>) {
    setBusy(true);
    try {
      await api(`/api/videos/${video.id}`, { method: "PATCH", json: patch });
      onChange({ link: { ...video.link, ...local } });
      toast(done);
      return true;
    } catch (err) {
      toast((err as Error).message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-line-2">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <KeyRound className="size-4 shrink-0 text-ink-3" />
        <span className="flex-1">
          <span className="block text-sm font-medium">Require a password</span>
          <span className="block text-[13px] text-ink-3">{video.link.hasPassword ? "People outside your workspace must enter it." : "Anyone with the link can watch."}</span>
        </span>
        <Switch
          label="Require a password"
          checked={video.link.hasPassword || editingPassword}
          onChange={async (on) => {
            if (on) return setEditingPassword(true);
            setEditingPassword(false);
            if (video.link.hasPassword) await save({ linkPassword: null }, "Password removed", { hasPassword: false });
          }}
        />
      </div>
      {(editingPassword || video.link.hasPassword) && (
        <form
          className="flex gap-2 border-t border-line px-3.5 py-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await save({ linkPassword: password }, video.link.hasPassword ? "Password changed" : "Password set", { hasPassword: true })) {
              setPassword("");
              setEditingPassword(false);
            }
          }}
        >
          <Input type="text" placeholder={video.link.hasPassword ? "New password (6+ characters)" : "Choose a password (6+ characters)"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" minLength={6} maxLength={200} />
          <Button type="submit" variant="secondary" loading={busy} disabled={password.length < 6}>
            {video.link.hasPassword ? "Change" : "Set"}
          </Button>
        </form>
      )}
      <div className="flex items-center gap-3 border-t border-line px-3.5 py-3">
        <Clock className="size-4 shrink-0 text-ink-3" />
        <span className="flex-1">
          <span className="block text-sm font-medium">Link expires</span>
          <span className={cx("block text-[13px]", expired ? "text-danger" : "text-ink-3")}>
            {video.link.expiresAt ? (expired ? `Expired on ${formatDate(video.link.expiresAt)}` : `Stops working on ${formatDate(video.link.expiresAt)}`) : "The link keeps working."}
          </span>
        </span>
        <Select
          className="h-9 w-36"
          value=""
          disabled={busy}
          onChange={async (e) => {
            const v = e.target.value;
            if (!v) return;
            const at = v === "never" ? null : Date.now() + Number(v) * 86400e3;
            await save({ linkExpiresAt: at }, at ? `Link expires on ${formatDate(at)}` : "Link no longer expires", { expiresAt: at });
          }}
        >
          <option value="" disabled>
            {video.link.expiresAt ? "Change…" : "Never"}
          </option>
          {EXPIRY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
