"use client";

import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { initials } from "@/lib/format";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

// ───────── Button ─────────

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-white hover:bg-brand-hover shadow-[0_1px_2px_rgba(255,79,82,0.35)]",
  accent: "bg-accent text-white hover:bg-[#5651e0]",
  secondary: "bg-surface text-ink border border-line-2 hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "bg-danger text-white hover:bg-red-700",
};
const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-[10px]",
  lg: "h-12 px-5 text-[15px] gap-2 rounded-xl",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = "primary", size = "md", loading, icon, className, children, disabled, ...props }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cx(
          "focus-ring inline-flex shrink-0 items-center justify-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        {...props}
      >
        {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
        {children}
      </button>
    );
  },
);

// ───────── Inputs ─────────

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        "focus-ring h-10 w-full rounded-[10px] border border-line-2 bg-surface px-3 text-sm text-ink placeholder:text-ink-4 focus-visible:border-ink-4",
        className,
      )}
      {...props}
    />
  );
});

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  const id = useId();
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-1.5 block text-[13px] font-medium text-ink-2">{label}</span>
      <div data-field-id={id}>{children}</div>
      {error ? <span className="mt-1.5 block text-[13px] text-danger">{error}</span> : hint ? <span className="mt-1.5 block text-[13px] text-ink-3">{hint}</span> : null}
    </label>
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select
        className={cx("focus-ring h-10 w-full appearance-none rounded-[10px] border border-line-2 bg-surface pl-3 pr-9 text-sm text-ink", className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
    </span>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx("focus-ring relative h-6 w-10 shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-line-2")}
    >
      <span className={cx("absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform", checked && "translate-x-4")} />
    </button>
  );
}

// ───────── Avatar ─────────

const AVATAR_COLORS = ["#625df5", "#ff4f52", "#0ea5e9", "#16a34a", "#f59e0b", "#d946ef", "#0f766e"];

export function Avatar({ name, url, size = 32, className }: { name: string; url?: string | null; size?: number; className?: string }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={size} height={size} className={cx("shrink-0 rounded-full object-cover", className)} style={{ width: size, height: size }} />
  ) : (
    <span
      className={cx("inline-grid shrink-0 place-items-center rounded-full font-semibold text-white", className)}
      style={{ width: size, height: size, background: color, fontSize: Math.max(10, size * 0.4) }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

// ───────── Menu (dropdown) ─────────

export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean } | "separator";

export function Menu({ trigger, items, align = "end", className }: { trigger: ReactNode; items: MenuItem[]; align?: "start" | "end"; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className={cx("relative", className)}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div
          role="menu"
          className={cx("animate-pop absolute top-full z-50 mt-1 min-w-48 rounded-xl bg-surface p-1.5 shadow-[var(--shadow-pop)]", align === "end" ? "right-0" : "left-0")}
        >
          {items.map((item, i) =>
            item === "separator" ? (
              <div key={i} className="my-1 h-px bg-line" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cx(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm disabled:opacity-40",
                  item.danger ? "text-danger hover:bg-red-50" : "text-ink hover:bg-surface-2",
                )}
              >
                {item.icon && <span className="text-ink-3 [&>svg]:size-4">{item.icon}</span>}
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ───────── Dialog ─────────

export function Dialog({ open, onClose, title, children, width = 480 }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[calc(100vw-32px)] rounded-2xl bg-surface p-0 text-ink shadow-[var(--shadow-pop)] backdrop:bg-ink/45"
      style={{ maxWidth: width }}
    >
      <div className="animate-pop p-6">
        {title && <h2 className="mb-4 text-lg font-semibold">{title}</h2>}
        {children}
      </div>
    </dialog>
  );
}

// ───────── bits ─────────

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin text-ink-3", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-line-2 bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] font-medium text-ink-2">{children}</kbd>;
}

export function CheckItem({ checked, children }: { checked: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className={cx("grid size-4 place-items-center rounded-full", checked ? "bg-accent text-white" : "border border-line-2")}>{checked && <Check className="size-3" />}</span>
      {children}
    </span>
  );
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-2 px-6 py-16 text-center">
      {icon && <div className="mb-4 text-ink-4 [&>svg]:size-10">{icon}</div>}
      <p className="font-semibold">{title}</p>
      {text && <p className="mt-1 max-w-sm text-sm text-ink-3">{text}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Tiny helper for JSON calls from client components; throws with the server's message. */
export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.json !== undefined ? { "content-type": "application/json" } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}
