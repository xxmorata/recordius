"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Copy, KeyRound, Link2, MoreHorizontal, Trash2, UserMinus } from "lucide-react";
import { Avatar, Button, Dialog, Field, Input, Menu, Select, api } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { formatRelative, pluralize } from "@/lib/format";
import { PRIVACY_LABELS, type Privacy } from "@/lib/types";
import type { Invite, Member, Role } from "@/lib/types";

type Props = {
  workspace: { name: string; defaultPrivacy: Privacy };
  members: Array<Member & { avatarUrl: string | null }>;
  invites: Invite[];
  me: { id: string; role: Role };
  canManage: boolean;
};

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function WorkspaceSettings({ workspace, members, invites: initialInvites, me, canManage }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(workspace.name);
  const [privacy, setPrivacy] = useState(workspace.defaultPrivacy);
  const [saving, setSaving] = useState(false);
  const [invites, setInvites] = useState(initialInvites);
  const [newInvite, setNewInvite] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [creating, setCreating] = useState(false);
  const [resetLink, setResetLink] = useState<{ name: string; url: string } | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/workspace", { method: "PATCH", json: { name, defaultPrivacy: privacy } });
      toast("Workspace settings saved");
      router.refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function createInvite() {
    setCreating(true);
    try {
      const r = await api<{ id: string; url: string }>("/api/workspace/invites", { method: "POST", json: { role: inviteRole, expiresInDays: 14 } });
      setNewInvite(r.url);
      await copy(r.url, "new");
      const list = await api<{ invites: Invite[] }>("/api/workspace/invites");
      setInvites(list.invites);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    await api(`/api/workspace/invites/${id}`, { method: "DELETE" }).catch((err) => toast(err.message, "error"));
    setInvites((all) => all.filter((i) => i.id !== id));
    if (newInvite) setNewInvite(null);
  }

  async function setRole(m: Member, role: Role) {
    try {
      await api(`/api/workspace/members/${m.id}`, { method: "PATCH", json: { role } });
      toast(`${m.name} is now ${ROLE_LABEL[role].toLowerCase()}`);
      router.refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function remove(m: Member) {
    setRemoving(null);
    try {
      await api(`/api/workspace/members/${m.id}`, { method: "DELETE" });
      toast(`${m.name} was removed`);
      router.refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function reset(m: Member) {
    try {
      const r = await api<{ url: string }>(`/api/workspace/members/${m.id}/reset`, { method: "POST" });
      setResetLink({ name: m.name, url: r.url });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {canManage && (
        <section className="card p-6">
          <h2 className="font-semibold">Workspace</h2>
          <form onSubmit={save} className="mt-4 flex max-w-md flex-col gap-4">
            <Field label="Workspace name">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            </Field>
            <Field label="Default privacy for new recordings" hint="Each video can be changed afterwards from its Share dialog.">
              <Select value={privacy} onChange={(e) => setPrivacy(e.target.value as Privacy)}>
                {(Object.keys(PRIVACY_LABELS) as Privacy[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIVACY_LABELS[p].title}
                  </option>
                ))}
              </Select>
            </Field>
            <div>
              <Button type="submit" loading={saving} disabled={name.trim() === workspace.name && privacy === workspace.defaultPrivacy}>
                Save changes
              </Button>
            </div>
          </form>
        </section>
      )}

      {canManage && (
        <section className="card p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Invite people</h2>
              <p className="mt-0.5 text-sm text-ink-3">Anyone with an invite link can create an account in this workspace. Links expire after 14 days.</p>
            </div>
            <div className="flex items-center gap-2">
              <Select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "member" | "admin")} className="h-10 w-32">
                <option value="member">As member</option>
                <option value="admin">As admin</option>
              </Select>
              <Button onClick={createInvite} loading={creating} icon={<Link2 className="size-4" />}>
                Create invite link
              </Button>
            </div>
          </div>
          {newInvite && (
            <div className="animate-pop mt-4 rounded-xl bg-accent-soft p-4">
              <p className="text-sm font-medium text-accent">Link copied — send it to your teammate.</p>
              <div className="mt-2 flex gap-2">
                <Input readOnly value={newInvite} className="bg-surface font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button variant="secondary" onClick={() => copy(newInvite, "new")} icon={copied === "new" ? <Check className="size-4" /> : <Copy className="size-4" />}>
                  {copied === "new" ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}
          {invites.length > 0 && (
            <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
              {invites.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <Link2 className="size-4 text-ink-3" />
                  <span className="flex-1">
                    Invite as {ROLE_LABEL[i.role].toLowerCase()} · created {formatRelative(i.createdAt)}
                    {i.createdBy ? ` by ${i.createdBy}` : ""} · used {i.uses}×
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => revoke(i.id)} icon={<Trash2 className="size-4" />}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="card p-6">
        <h2 className="font-semibold">{pluralize(members.length, "member")}</h2>
        <ul className="mt-4 divide-y divide-line">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-3">
              <Avatar name={m.name} url={m.avatarUrl} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {m.name}
                  {m.id === me.id && <span className="ml-1.5 text-ink-4">(you)</span>}
                </p>
                <p className="truncate text-[13px] text-ink-3">
                  {m.email} · {pluralize(m.videos, "video")}
                </p>
              </div>
              <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-2">{ROLE_LABEL[m.role]}</span>
              {canManage && m.id !== me.id && m.role !== "owner" && (
                <Menu
                  trigger={
                    <button type="button" className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-2" aria-label="Member actions">
                      <MoreHorizontal className="size-5" />
                    </button>
                  }
                  items={[
                    m.role === "admin"
                      ? { label: "Make member", onSelect: () => setRole(m, "member"), disabled: me.role !== "owner" }
                      : { label: "Make admin", onSelect: () => setRole(m, "admin") },
                    ...(me.role === "owner" ? [{ label: "Transfer ownership", onSelect: () => setRole(m, "owner") }] : []),
                    { label: "Create password reset link", icon: <KeyRound />, onSelect: () => reset(m) },
                    "separator",
                    { label: "Remove from workspace", icon: <UserMinus />, danger: true, onSelect: () => setRemoving(m), disabled: m.role === "admin" && me.role !== "owner" },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      </section>

      <Dialog open={Boolean(resetLink)} onClose={() => setResetLink(null)} title={`Password reset for ${resetLink?.name}`} width={480}>
        <p className="text-sm text-ink-2">Send this link to {resetLink?.name}. It works once and expires in 2 days.</p>
        <div className="mt-3 flex gap-2">
          <Input readOnly value={resetLink?.url ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button onClick={() => resetLink && copy(resetLink.url, "reset")} icon={copied === "reset" ? <Check className="size-4" /> : <Copy className="size-4" />}>
            {copied === "reset" ? "Copied" : "Copy"}
          </Button>
        </div>
      </Dialog>

      <Dialog open={Boolean(removing)} onClose={() => setRemoving(null)} title={`Remove ${removing?.name}?`} width={420}>
        <p className="text-sm text-ink-2">
          Their account on this Recordius will be deleted and the desktop app will be disconnected. Their videos stay in the workspace.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRemoving(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => removing && remove(removing)}>
            Remove member
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
