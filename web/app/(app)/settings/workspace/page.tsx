import { WorkspaceSettings } from "./WorkspaceSettings";
import { canManageWorkspace, requireUser } from "@/lib/auth";
import { viewUrl } from "@/lib/blob";
import { listInvites, listMembers } from "@/lib/workspace";

export const metadata = { title: "Members & workspace" };

export default async function WorkspacePage() {
  const user = await requireUser();
  const manage = canManageWorkspace(user);
  const [members, invites] = await Promise.all([listMembers(user), manage ? listInvites(user) : []]);
  const withAvatars = await Promise.all(members.map(async (m) => ({ ...m, avatarUrl: m.avatarPath ? await viewUrl(m.avatarPath) : null })));
  return (
    <WorkspaceSettings
      workspace={{ name: user.workspace.name, defaultPrivacy: user.workspace.defaultPrivacy }}
      members={withAvatars}
      invites={invites}
      me={{ id: user.id, role: user.role }}
      canManage={manage}
    />
  );
}
