import { sql } from "./db";
import { deletePrefix } from "./blob";
import { HttpError, canManageWorkspace, type CurrentUser, type Role } from "./auth";
import { hashPassword, hashToken, isEmail, normalizeEmail, randomToken, verifyPassword } from "./ids";
import { openSignupAllowed } from "./env";
import type { Privacy } from "./types";

import type { Invite, Member } from "./types";
export type { Invite, Member };

export async function hasAnyUser(): Promise<boolean> {
  const rows = await sql()`select 1 from users limit 1`;
  return rows.length > 0;
}

/** Creates a user + their own workspace. Used for first-run setup and (if enabled) open signup. */
export async function createWorkspaceWithOwner(input: { name: string; email: string; password: string; workspaceName: string }) {
  const email = normalizeEmail(input.email);
  validateSignup(input.name, email, input.password);
  const workspaceName = input.workspaceName.trim().slice(0, 80) || `${input.name.trim()}'s workspace`;
  const passwordHash = await hashPassword(input.password);
  return sql().begin(async (tx) => {
    const existing = await tx`select 1 from users where email = ${email}`;
    if (existing.length) throw new HttpError(409, "An account with this email already exists");
    const [ws] = await tx`insert into workspaces (name) values (${workspaceName}) returning id`;
    const [user] = await tx`insert into users (email, name, password_hash) values (${email}, ${input.name.trim().slice(0, 80)}, ${passwordHash}) returning id`;
    await tx`insert into memberships (workspace_id, user_id, role) values (${ws.id}, ${user.id}, 'owner')`;
    return { userId: user.id as string, workspaceId: ws.id as string };
  });
}

export async function signupAllowed(): Promise<"setup" | "open" | "closed"> {
  if (!(await hasAnyUser())) return "setup";
  return openSignupAllowed() ? "open" : "closed";
}

function validateSignup(name: string, email: string, password: string) {
  if (!name.trim()) throw new HttpError(400, "Enter your name");
  if (!isEmail(email)) throw new HttpError(400, "Enter a valid email address");
  if (password.length < 8) throw new HttpError(400, "Use a password of at least 8 characters");
}

// Unknown emails still cost one scrypt run, so response times don't reveal which accounts exist.
let dummyHash: Promise<string> | null = null;

export async function authenticate(email: string, password: string): Promise<string> {
  const rows = await sql()`select id, password_hash from users where email = ${normalizeEmail(email)}`;
  dummyHash ??= hashPassword(randomToken(16));
  const ok = await verifyPassword(password, rows[0]?.password_hash ?? (await dummyHash)).then((v) => v && Boolean(rows[0]));
  if (!ok) throw new HttpError(401, "Wrong email or password");
  return rows[0].id as string;
}

export async function changePassword(user: CurrentUser, current: string, next: string) {
  const rows = await sql()`select password_hash from users where id = ${user.id}`;
  if (!(await verifyPassword(current, rows[0].password_hash))) throw new HttpError(400, "Your current password is wrong");
  if (next.length < 8) throw new HttpError(400, "Use a password of at least 8 characters");
  await sql()`update users set password_hash = ${await hashPassword(next)} where id = ${user.id}`;
  // Sign out every other session and disconnect the desktop apps: a password change is often a reaction
  // to a suspected leak. (The caller signs this browser in again.)
  await sql()`delete from sessions where user_id = ${user.id}`;
  await sql()`delete from device_tokens where user_id = ${user.id}`;
}

export async function updateProfile(user: CurrentUser, patch: { name?: string; avatarPath?: string | null }) {
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 80);
    if (!name) throw new HttpError(400, "Enter your name");
    await sql()`update users set name = ${name} where id = ${user.id}`;
  }
  if (patch.avatarPath !== undefined) await sql()`update users set avatar_path = ${patch.avatarPath} where id = ${user.id}`;
}

// ───────── members ─────────

export async function listMembers(user: CurrentUser): Promise<Member[]> {
  const rows = await sql()`
    select u.id, u.name, u.email, u.avatar_path, m.role, m.created_at,
      (select count(*) from videos v where v.owner_id = u.id and v.workspace_id = m.workspace_id and v.archived_at is null) as videos
    from memberships m join users u on u.id = m.user_id
    where m.workspace_id = ${user.workspace.id}
    order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.created_at`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    avatarPath: r.avatar_path,
    joinedAt: new Date(r.created_at).getTime(),
    videos: Number(r.videos),
  }));
}

export async function setMemberRole(user: CurrentUser, memberId: string, role: Role) {
  if (!canManageWorkspace(user)) throw new HttpError(403, "Only admins can change roles");
  if (memberId === user.id) throw new HttpError(400, "You can't change your own role");
  if (role === "owner" && user.role !== "owner") throw new HttpError(403, "Only the owner can transfer ownership");
  if (!["owner", "admin", "member"].includes(role)) throw new HttpError(400, "Unknown role");
  await sql().begin(async (tx) => {
    const target = await tx`select role from memberships where workspace_id = ${user.workspace.id} and user_id = ${memberId}`;
    if (!target[0]) throw new HttpError(404, "Member not found");
    if (target[0].role === "owner") throw new HttpError(403, "The owner's role can't be changed");
    if (target[0].role === "admin" && user.role !== "owner") throw new HttpError(403, "Only the owner can change another admin's role");
    if (role === "owner") await tx`update memberships set role = 'admin' where workspace_id = ${user.workspace.id} and user_id = ${user.id}`;
    await tx`update memberships set role = ${role} where workspace_id = ${user.workspace.id} and user_id = ${memberId}`;
  });
}

export async function removeMember(user: CurrentUser, memberId: string) {
  if (!canManageWorkspace(user)) throw new HttpError(403, "Only admins can remove members");
  if (memberId === user.id) throw new HttpError(400, "You can't remove yourself");
  const target = await sql()`select role from memberships where workspace_id = ${user.workspace.id} and user_id = ${memberId}`;
  if (!target[0]) throw new HttpError(404, "Member not found");
  if (target[0].role === "owner") throw new HttpError(403, "The owner can't be removed");
  if (target[0].role === "admin" && user.role !== "owner") throw new HttpError(403, "Only the owner can remove an admin");
  // Their videos stay in the workspace (handed to the admin who removes them); the account itself is removed.
  await sql().begin(async (tx) => {
    await tx`update videos set owner_id = ${user.id} where owner_id = ${memberId} and workspace_id = ${user.workspace.id}`;
    await tx`delete from users where id = ${memberId}`;
  });
  // Their profile picture goes with the account.
  await deletePrefix(`avatars/${memberId}/`).catch((err) => console.error("avatar cleanup failed", memberId, err));
}

export async function updateWorkspace(user: CurrentUser, patch: { name?: string; defaultPrivacy?: Privacy }) {
  if (!canManageWorkspace(user)) throw new HttpError(403, "Only admins can change workspace settings");
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 80);
    if (!name) throw new HttpError(400, "Enter a workspace name");
    await sql()`update workspaces set name = ${name} where id = ${user.workspace.id}`;
  }
  if (patch.defaultPrivacy !== undefined) {
    if (!["link", "workspace", "private"].includes(patch.defaultPrivacy)) throw new HttpError(400, "Unknown privacy setting");
    await sql()`update workspaces set default_privacy = ${patch.defaultPrivacy} where id = ${user.workspace.id}`;
  }
}

// ───────── invites ─────────

export async function listInvites(user: CurrentUser): Promise<Invite[]> {
  const rows = await sql()`
    select i.id, i.role, i.uses, i.max_uses, i.expires_at, i.created_at, u.name as created_by
    from invites i left join users u on u.id = i.created_by
    where i.workspace_id = ${user.workspace.id} and i.revoked_at is null and (i.expires_at is null or i.expires_at > now())
    order by i.created_at desc`;
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    uses: r.uses,
    maxUses: r.max_uses,
    expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
    createdAt: new Date(r.created_at).getTime(),
    createdBy: r.created_by,
  }));
}

export async function createInvite(user: CurrentUser, opts: { role?: "admin" | "member"; expiresInDays?: number | null; maxUses?: number | null }) {
  if (!canManageWorkspace(user)) throw new HttpError(403, "Only admins can invite people");
  const role = opts.role === "admin" ? "admin" : "member";
  const token = randomToken(24);
  const expiresAt = opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86400e3) : null;
  const [row] = await sql()`insert into invites (workspace_id, token_hash, created_by, role, expires_at, max_uses)
    values (${user.workspace.id}, ${hashToken(token)}, ${user.id}, ${role}, ${expiresAt}, ${opts.maxUses ?? null}) returning id`;
  return { id: row.id as string, token };
}

export async function revokeInvite(user: CurrentUser, id: string) {
  if (!canManageWorkspace(user)) throw new HttpError(403, "Only admins can revoke invites");
  await sql()`update invites set revoked_at = now() where id = ${id} and workspace_id = ${user.workspace.id}`;
}

export type InvitePreview = { workspaceName: string; role: Role; invitedBy: string | null };

export async function previewInvite(token: string): Promise<InvitePreview> {
  const rows = await sql()`
    select w.name as workspace_name, i.role, u.name as invited_by
    from invites i join workspaces w on w.id = i.workspace_id left join users u on u.id = i.created_by
    where i.token_hash = ${hashToken(token)} and i.revoked_at is null
      and (i.expires_at is null or i.expires_at > now()) and (i.max_uses is null or i.uses < i.max_uses)`;
  if (!rows[0]) throw new HttpError(404, "This invite link is no longer valid");
  return { workspaceName: rows[0].workspace_name, role: rows[0].role, invitedBy: rows[0].invited_by };
}

/** Accepts an invite with a brand-new account. Existing accounts can't join a second workspace (one workspace per account). */
export async function acceptInvite(token: string, input: { name: string; email: string; password: string }) {
  const email = normalizeEmail(input.email);
  validateSignup(input.name, email, input.password);
  const passwordHash = await hashPassword(input.password);
  return sql().begin(async (tx) => {
    const invites = await tx`select id, workspace_id, role from invites where token_hash = ${hashToken(token)} and revoked_at is null
      and (expires_at is null or expires_at > now()) and (max_uses is null or uses < max_uses) for update`;
    if (!invites[0]) throw new HttpError(404, "This invite link is no longer valid");
    const existing = await tx`select 1 from users where email = ${email}`;
    if (existing.length) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
    const [user] = await tx`insert into users (email, name, password_hash) values (${email}, ${input.name.trim().slice(0, 80)}, ${passwordHash}) returning id`;
    await tx`insert into memberships (workspace_id, user_id, role) values (${invites[0].workspace_id}, ${user.id}, ${invites[0].role})`;
    await tx`update invites set uses = uses + 1 where id = ${invites[0].id}`;
    return user.id as string;
  });
}

// ───────── password resets (no email provider needed: an admin hands the link over) ─────────

export async function createPasswordReset(user: CurrentUser, memberId: string): Promise<string> {
  const member = await sql()`select role from memberships where workspace_id = ${user.workspace.id} and user_id = ${memberId}`;
  if (!member[0]) throw new HttpError(404, "Member not found");
  // You change your own password in Settings, with the current one — a reset link for yourself would let
  // anyone holding a stolen session take the account over without knowing the password.
  if (memberId === user.id) throw new HttpError(400, "Change your own password in Settings → Profile");
  // Same rules as changing roles: nobody resets the owner's password, and only the owner resets an admin's.
  if (!canManageWorkspace(user)) throw new HttpError(403, "Only admins can reset passwords");
  if (member[0].role === "owner") throw new HttpError(403, "The owner's password can only be reset by the owner");
  if (member[0].role === "admin" && user.role !== "owner") throw new HttpError(403, "Only the owner can reset an admin's password");
  const token = randomToken(24);
  await sql()`insert into password_resets (user_id, token_hash, expires_at) values (${memberId}, ${hashToken(token)}, now() + interval '2 days')`;
  return token;
}

export async function consumePasswordReset(token: string, password: string): Promise<string> {
  if (password.length < 8) throw new HttpError(400, "Use a password of at least 8 characters");
  return sql().begin(async (tx) => {
    const rows = await tx`select id, user_id from password_resets where token_hash = ${hashToken(token)} and used_at is null and expires_at > now() for update`;
    if (!rows[0]) throw new HttpError(404, "This reset link is no longer valid");
    await tx`update users set password_hash = ${await hashPassword(password)} where id = ${rows[0].user_id}`;
    await tx`update password_resets set used_at = now() where id = ${rows[0].id}`;
    // A reset means the old credentials may be in the wrong hands: sign out everywhere, desktop apps included.
    await tx`delete from sessions where user_id = ${rows[0].user_id}`;
    await tx`delete from device_tokens where user_id = ${rows[0].user_id}`;
    return rows[0].user_id as string;
  });
}
