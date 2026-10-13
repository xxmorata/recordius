import { cookies, headers } from "next/headers";
import { cache } from "react";
import { sql } from "./db";
import { hashToken, randomToken } from "./ids";

export const SESSION_COOKIE = "recordius_session";
const SESSION_DAYS = 90;

import type { Role } from "./types";
export type { Role };

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  avatarPath: string | null;
  workspace: { id: string; name: string; defaultPrivacy: "link" | "workspace" | "private" };
  role: Role;
  /** "session" for the browser, "device" for the desktop app. */
  via: "session" | "device";
};

type UserRow = {
  id: string;
  email: string;
  name: string;
  avatar_path: string | null;
  workspace_id: string;
  workspace_name: string;
  default_privacy: "link" | "workspace" | "private";
  role: Role;
};

function toUser(row: UserRow, via: CurrentUser["via"]): CurrentUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarPath: row.avatar_path,
    workspace: { id: row.workspace_id, name: row.workspace_name, defaultPrivacy: row.default_privacy },
    role: row.role,
    via,
  };
}

const USER_SELECT = `
  select u.id, u.email, u.name, u.avatar_path, w.id as workspace_id, w.name as workspace_name, w.default_privacy, m.role
  from users u
  join memberships m on m.user_id = u.id
  join workspaces w on w.id = m.workspace_id`;

async function userForSession(token: string): Promise<CurrentUser | null> {
  const db = sql();
  const rows = await db.unsafe<UserRow[]>(
    `${USER_SELECT}
     join sessions s on s.user_id = u.id
     where s.token_hash = $1 and s.expires_at > now()
     order by m.created_at asc limit 1`,
    [hashToken(token)],
  );
  if (!rows[0]) return null;
  // Touch at most once an hour to keep writes down.
  await db`update sessions set last_seen_at = now() where token_hash = ${hashToken(token)} and last_seen_at < now() - interval '1 hour'`;
  return toUser(rows[0], "session");
}

async function userForDeviceToken(token: string): Promise<CurrentUser | null> {
  const db = sql();
  const rows = await db.unsafe<UserRow[]>(
    `${USER_SELECT}
     join device_tokens d on d.user_id = u.id and d.workspace_id = w.id
     where d.token_hash = $1 limit 1`,
    [hashToken(token)],
  );
  if (!rows[0]) return null;
  await db`update device_tokens set last_used_at = now() where token_hash = ${hashToken(token)} and (last_used_at is null or last_used_at < now() - interval '10 minutes')`;
  return toUser(rows[0], "device");
}

/** Current user from the session cookie or a desktop bearer token; cached per request. */
export const currentUser = cache(async (): Promise<CurrentUser | null> => {
  const h = await headers();
  const auth = h.get("authorization");
  if (auth?.startsWith("Bearer ")) return userForDeviceToken(auth.slice(7).trim());
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return userForSession(token);
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in to continue");
  return user;
}

export function canManageWorkspace(user: CurrentUser): boolean {
  return user.role === "owner" || user.role === "admin";
}

export async function createSession(userId: string, userAgent: string | null): Promise<string> {
  const token = randomToken(32);
  await sql()`insert into sessions (user_id, token_hash, user_agent, expires_at)
    values (${userId}, ${hashToken(token)}, ${userAgent}, now() + ${`${SESSION_DAYS} days`}::interval)`;
  return token;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * SESSION_DAYS,
  });
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await sql()`delete from sessions where token_hash = ${hashToken(token)}`;
  store.delete(SESSION_COOKIE);
}

export async function createDeviceToken(userId: string, workspaceId: string, name: string): Promise<{ id: string; token: string }> {
  const token = `rcd_${randomToken(32)}`;
  const [row] = await sql()`insert into device_tokens (user_id, workspace_id, name, token_hash)
    values (${userId}, ${workspaceId}, ${name.slice(0, 120)}, ${hashToken(token)}) returning id`;
  return { id: row.id, token };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  console.error(err);
  return Response.json({ error: "Something went wrong" }, { status: 500 });
}

/** Wraps a route handler so thrown HttpErrors become JSON responses. */
export function route<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}
