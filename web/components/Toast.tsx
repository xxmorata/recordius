"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, X } from "lucide-react";

type Toast = { id: number; kind: "success" | "error"; text: string };
type Ctx = { toast: (text: string, kind?: Toast["kind"]) => void };

const ToastContext = createContext<Ctx>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const toast = useCallback((text: string, kind: Toast["kind"] = "success") => {
    const id = nextId.current++;
    setToasts((all) => [...all.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), kind === "error" ? 5000 : 2600);
  }, []);
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-[100] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="animate-pop pointer-events-auto flex max-w-md items-center gap-2.5 rounded-xl bg-ink px-4 py-3 text-sm font-medium text-white shadow-[var(--shadow-pop)]"
          >
            {t.kind === "success" ? <CheckCircle2 className="size-4 shrink-0 text-green-400" /> : <CircleAlert className="size-4 shrink-0 text-brand" />}
            <span>{t.text}</span>
            <button type="button" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} className="ml-1 rounded p-0.5 text-white/60 hover:text-white" aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
