import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { Field, Input } from "@/components/ui";
import { currentUser } from "@/lib/auth";
import { schemaReady } from "@/lib/db";
import { signupAllowed } from "@/lib/workspace";

export const metadata = { title: "Create a workspace" };
export const dynamic = "force-dynamic";

export default async function Signup() {
  if (!(await schemaReady())) redirect("/setup");
  const mode = await signupAllowed();
  if (mode === "setup") redirect("/setup");
  if (await currentUser()) redirect("/library");
  if (mode === "closed") {
    return (
      <>
        <h1 className="text-xl font-semibold">Invite only</h1>
        <p className="mt-2 text-sm text-ink-3">
          This Recordius server doesn’t allow open sign-ups. Ask a workspace admin for an invite link — it looks like <code className="rounded bg-surface-2 px-1">/join/…</code>.
        </p>
        <Link href="/login" className="mt-6 block text-center text-sm font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </>
    );
  }
  return (
    <>
      <h1 className="text-xl font-semibold">Create a workspace</h1>
      <p className="mt-1 mb-6 text-sm text-ink-3">A workspace is where your team’s videos live.</p>
      <AuthForm action="/api/auth/signup" submitLabel="Create workspace">
        <Field label="Workspace name">
          <Input name="workspaceName" required autoFocus placeholder="Acme Design Studio" maxLength={80} />
        </Field>
        <Field label="Your name">
          <Input name="name" autoComplete="name" required maxLength={80} />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input name="password" type="password" autoComplete="new-password" required minLength={8} />
        </Field>
      </AuthForm>
      <p className="mt-6 text-center text-[13px] text-ink-3">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
