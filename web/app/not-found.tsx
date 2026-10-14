import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-4 text-center">
      <div className="flex flex-col items-center gap-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/mascot-256.png" alt="" className="h-28 w-auto opacity-90" />
        <Wordmark className="h-6 text-ink" />
        <div>
          <h1 className="text-xl font-semibold">We couldn’t find that page</h1>
          <p className="mt-1 text-sm text-ink-3">The link may be incomplete, or the video was deleted.</p>
        </div>
        <Link href="/" className="text-sm font-medium text-accent hover:underline">
          Go to Recordius
        </Link>
      </div>
    </main>
  );
}
