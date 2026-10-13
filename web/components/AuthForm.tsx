"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button, api } from "@/components/ui";

type Props = {
  action: string;
  submitLabel: string;
  children: ReactNode;
  redirectTo?: string;
  extra?: Record<string, unknown>;
  footer?: ReactNode;
};

/** Posts the form fields as JSON and navigates on success; shows the server's error text otherwise. */
export function AuthForm({ action, submitLabel, children, redirectTo = "/library", extra, footer }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      await api(action, { method: "POST", json: { ...data, ...extra } });
      router.replace(redirectTo);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {children}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" loading={loading} className="mt-1 w-full">
        {submitLabel}
      </Button>
      {footer}
    </form>
  );
}
