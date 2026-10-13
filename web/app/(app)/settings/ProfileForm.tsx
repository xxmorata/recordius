"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Avatar, Button, Field, Input, api } from "@/components/ui";
import { useToast } from "@/components/Toast";

export function ProfileForm({ user }: { user: { name: string; email: string; avatarUrl: string | null } }) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(user.name);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/profile", { method: "PATCH", json: { name } });
      toast("Profile saved");
      router.refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function upload(f: File) {
    setUploading(true);
    const form = new FormData();
    form.set("file", f);
    try {
      const r = await api<{ avatarUrl: string }>("/api/profile/avatar", { method: "POST", body: form });
      setAvatarUrl(r.avatarUrl);
      toast("Photo updated");
      router.refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    await api("/api/profile/avatar", { method: "DELETE" });
    setAvatarUrl(null);
    router.refresh();
  }

  async function changePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const form = e.currentTarget;
    try {
      await api("/api/auth/password", { method: "POST", json: { current: data.get("current"), next: data.get("next") } });
      form.reset();
      toast("Password changed. Other sessions were signed out.");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="card p-6">
        <h2 className="font-semibold">Profile</h2>
        <p className="mt-0.5 text-sm text-ink-3">Shown on your videos and share pages.</p>
        <div className="mt-5 flex items-center gap-4">
          <Avatar name={name || user.name} url={avatarUrl} size={64} />
          <div className="flex gap-2">
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button variant="secondary" size="sm" loading={uploading} onClick={() => file.current?.click()}>
              Upload photo
            </Button>
            {avatarUrl && (
              <Button variant="ghost" size="sm" onClick={removeAvatar}>
                Remove
              </Button>
            )}
          </div>
        </div>
        <form onSubmit={saveName} className="mt-5 flex max-w-md flex-col gap-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          </Field>
          <Field label="Email" hint="Your sign-in email can’t be changed yet.">
            <Input value={user.email} readOnly className="bg-surface-2 text-ink-3" />
          </Field>
          <div>
            <Button type="submit" loading={saving} disabled={name.trim() === user.name || !name.trim()}>
              Save changes
            </Button>
          </div>
        </form>
      </section>

      <section className="card p-6">
        <h2 className="font-semibold">Password</h2>
        <form onSubmit={changePassword} className="mt-4 flex max-w-md flex-col gap-4">
          <Field label="Current password">
            <Input name="current" type="password" autoComplete="current-password" required />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <Input name="next" type="password" autoComplete="new-password" required minLength={8} />
          </Field>
          <div>
            <Button type="submit" variant="secondary">
              Change password
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
