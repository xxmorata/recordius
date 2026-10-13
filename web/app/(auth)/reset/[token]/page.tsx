import { AuthForm } from "@/components/AuthForm";
import { Field, Input } from "@/components/ui";

export const metadata = { title: "Reset password" };

export default async function Reset({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <p className="mt-1 mb-6 text-sm text-ink-3">You’ll be signed in right after.</p>
      <AuthForm action="/api/auth/reset" submitLabel="Set password" extra={{ token }}>
        <Field label="New password" hint="At least 8 characters.">
          <Input name="password" type="password" autoComplete="new-password" required minLength={8} autoFocus />
        </Field>
      </AuthForm>
    </>
  );
}
