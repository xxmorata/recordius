import { SettingsNav } from "./SettingsNav";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-6">
        <p className="text-[13px] font-medium text-ink-3">Workspace</p>
        <h1 className="text-[26px] font-semibold tracking-tight">Settings</h1>
      </div>
      <div className="flex flex-col gap-6 lg:flex-row lg:gap-10">
        <SettingsNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
