import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { Field, Input } from "@/components/ui";
import { migrate, schemaReady } from "@/lib/db";
import { hasAnyUser } from "@/lib/workspace";

export const metadata = { title: "Set up Recordius" };
export const dynamic = "force-dynamic";

/** First run: creates the database schema if needed, then the first account + workspace. */
export default async function Setup() {
  if (!(await schemaReady())) await migrate();
  if (await hasAnyUser()) redirect("/login");
  return (
    <>
      <div className="mb-6 flex items-start gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/mascot-512.png" alt="" className="h-16 w-auto" />
        <div>
          <h1 className="text-xl font-semibold">Set up your workspace</h1>
          <p className="mt-1 text-sm text-ink-3">You’ll be the owner. Invite your team afterwards from Settings.</p>
        </div>
      </div>
      <AuthForm action="/api/auth/signup" submitLabel="Create workspace">
        <Field label="Workspace name">
          <Input name="workspaceName" required autoFocus placeholder="Acme Design Studio" maxLength={80} />
        </Field>
        <Field label="Your name">
          <Input name="name" autoComplete="name" required placeholder="Ada Lovelace" maxLength={80} />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" autoComplete="email" required placeholder="ada@acme.com" />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input name="password" type="password" autoComplete="new-password" required minLength={8} />
        </Field>
        {process.env.SETUP_TOKEN && (
          <Field label="Setup token" hint="The SETUP_TOKEN value from your server settings.">
            <Input name="setupToken" type="password" autoComplete="off" required />
          </Field>
        )}
      </AuthForm>
    </>
  );
}
