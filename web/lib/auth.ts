import { secureCookies } from "./env";
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
  // Touch at most once an hour to keep writes down — without making the request wait for it.
  db`update sessions set last_seen_at = now() where token_hash = ${hashToken(token)} and last_seen_at < now() - interval '1 hour'`.catch(() => {});
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
  db`update device_tokens set last_used_at = now() where token_hash = ${hashToken(token)} and (last_used_at is null or last_used_at < now() - interval '10 minutes')`.catch(() => {});
  return toUser(rows[0], "device");
}

const resolveUser = cache(async (allowDevice: boolean): Promise<CurrentUser | null> => {
  const h = await headers();
  const auth = h.get("authorization");
  if (auth?.startsWith("Bearer ")) return allowDevice ? userForDeviceToken(auth.slice(7).trim()) : null;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return userForSession(token);
});

type AuthOptions = {
  /**
   * Accept the desktop app's device token too. Only the handful of endpoints the recorder needs do:
   * a token copied off a Mac can create and upload recordings, but can't change passwords, members,
   * devices or settings.
   */
  device?: boolean;
};

/** Current user from the session cookie (or, with `device`, a desktop bearer token); cached per request. */
export function currentUser(opts: AuthOptions = {}): Promise<CurrentUser | null> {
  return resolveUser(Boolean(opts.device));
}

export async function requireUser(opts: AuthOptions = {}): Promise<CurrentUser> {
  const user = await currentUser(opts);
  if (user) return user;
  if (!opts.device && (await headers()).get("authorization")?.startsWith("Bearer ")) {
    throw new HttpError(403, "The desktop app can't do this — sign in on the web instead");
  }
  throw new HttpError(401, "Sign in to continue");
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
    secure: secureCookies(),
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
    /** Stable machine-readable reason for clients that act on it (e.g. the desktop upload queue). */
    public code?: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status });
  console.error(err);
  return Response.json({ error: "Something went wrong" }, { status: 500 });
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Browsers send Origin with every POST/PATCH/DELETE. A request from another site's page is refused, so no
 * page elsewhere can sign someone in, change their videos or post in their name (CSRF). The desktop app
 * and scripts send no Origin and authenticate with a bearer token instead.
 */
function crossSite(req: Request): boolean {
  if (!UNSAFE_METHODS.has(req.method)) return false;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  if (origin === "null") return true;
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** Wraps a route handler: refuses cross-site requests and turns thrown HttpErrors into JSON responses. */
export function route<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try {
      const req = args[0];
      if (req instanceof Request && crossSite(req)) throw new HttpError(403, "Requests from other sites aren't allowed");
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  // Only real JSON requests: an HTML form on another site can't send this content type.
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new HttpError(415, "Send the request body as JSON");
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}
