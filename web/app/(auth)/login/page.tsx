import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { Field, Input } from "@/components/ui";
import { currentUser } from "@/lib/auth";
import { schemaReady } from "@/lib/db";
import { hasAnyUser, signupAllowed } from "@/lib/workspace";
import { safeNextPath } from "@/lib/format";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!(await schemaReady()) || !(await hasAnyUser())) redirect("/setup");
  if (await currentUser()) redirect("/library");
  const { next } = await searchParams;
  const open = (await signupAllowed()) === "open";
  return (
    <>
      <h1 className="text-xl font-semibold">Welcome back</h1>
      <p className="mt-1 mb-6 text-sm text-ink-3">Sign in to your Recordius workspace.</p>
      <AuthForm action="/api/auth/login" submitLabel="Sign in" redirectTo={safeNextPath(next) ?? "/library"}>
        <Field label="Email">
          <Input name="email" type="email" autoComplete="email" required autoFocus placeholder="you@company.com" />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" autoComplete="current-password" required minLength={8} />
        </Field>
      </AuthForm>
      <p className="mt-6 text-center text-[13px] text-ink-3">
        {open ? (
          <>
            New here?{" "}
            <Link href="/signup" className="font-medium text-accent hover:underline">
              Create a workspace
            </Link>
          </>
        ) : (
          <>Need an account? Ask a workspace admin for an invite link.</>
        )}
      </p>
      <p className="mt-2 text-center text-[13px] text-ink-4">Forgot your password? An admin can send you a reset link from Settings → Members.</p>
    </>
  );
}
