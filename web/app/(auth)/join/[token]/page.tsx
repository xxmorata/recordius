import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { Field, Input } from "@/components/ui";
import { currentUser } from "@/lib/auth";
import { previewInvite } from "@/lib/workspace";

export const metadata = { title: "Join workspace" };
export const dynamic = "force-dynamic";

export default async function Join({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await currentUser();
  let invite: Awaited<ReturnType<typeof previewInvite>> | null = null;
  try {
    invite = await previewInvite(token);
  } catch {
    invite = null;
  }
  if (!invite) {
    return (
      <>
        <h1 className="text-xl font-semibold">This invite link isn’t valid anymore</h1>
        <p className="mt-2 text-sm text-ink-3">It may have expired, been revoked, or reached its limit. Ask the person who invited you for a new one.</p>
        <Link href="/login" className="mt-6 block text-center text-sm font-medium text-accent hover:underline">
          Go to sign in
        </Link>
      </>
    );
  }
  if (user) {
    if (user.workspace.name === invite.workspaceName) redirect("/library");
    return (
      <>
        <h1 className="text-xl font-semibold">You’re signed in as {user.email}</h1>
        <p className="mt-2 text-sm text-ink-3">
          An account belongs to one workspace. To join <b>{invite.workspaceName}</b>, sign out and open this link again with a different email.
        </p>
        <Link href="/library" className="mt-6 block text-center text-sm font-medium text-accent hover:underline">
          Stay in {user.workspace.name}
        </Link>
      </>
    );
  }
  return (
    <>
      <p className="text-[13px] font-medium text-accent">You’re invited</p>
      <h1 className="mt-1 text-xl font-semibold">Join {invite.workspaceName}</h1>
      <p className="mt-1 mb-6 text-sm text-ink-3">
        {invite.invitedBy ? `${invite.invitedBy} invited you` : "You were invited"} as {invite.role === "admin" ? "an admin" : "a member"}. Create your account to get started.
      </p>
      <AuthForm action={`/api/invites/${token}`} submitLabel={`Join ${invite.workspaceName}`}>
        <Field label="Your name">
          <Input name="name" autoComplete="name" required autoFocus maxLength={80} />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input name="password" type="password" autoComplete="new-password" required minLength={8} />
        </Field>
      </AuthForm>
      <p className="mt-6 text-center text-[13px] text-ink-3">
        Already a member?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
