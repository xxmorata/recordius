import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center px-4 py-10 sm:justify-center">
      <Link href="/" className="mb-8 text-ink" aria-label="Recordius">
        <Wordmark className="h-7" />
      </Link>
      <div className="card w-full max-w-[420px] p-7 sm:p-8">{children}</div>
      <p className="mt-6 text-center text-xs text-ink-4">Recordius is open source. Your videos stay on this server.</p>
    </main>
  );
}
