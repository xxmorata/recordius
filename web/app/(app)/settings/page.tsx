import { ProfileForm } from "./ProfileForm";
import { requireUser } from "@/lib/auth";
import { viewUrl } from "@/lib/blob";

export const metadata = { title: "Profile" };

export default async function ProfileSettings() {
  const user = await requireUser();
  const avatarUrl = user.avatarPath ? await viewUrl(user.avatarPath) : null;
  return <ProfileForm user={{ name: user.name, email: user.email, avatarUrl }} />;
}
