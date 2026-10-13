-- Recordius schema. Applied by `npm run db:migrate` or automatically on first visit to /setup.

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text not null,
  password_hash text not null,
  avatar_path   text,
  created_at    timestamptz not null default now()
);

create table workspaces (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  default_privacy text not null default 'link' check (default_privacy in ('link', 'workspace', 'private')),
  created_at      timestamptz not null default now()
);

create table memberships (
  workspace_id uuid not null references workspaces on delete cascade,
  user_id      uuid not null references users on delete cascade,
  role         text not null check (role in ('owner', 'admin', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index memberships_user on memberships (user_id);

create table invites (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  token_hash   text not null unique,
  created_by   uuid references users on delete set null,
  role         text not null default 'member' check (role in ('admin', 'member')),
  expires_at   timestamptz,
  max_uses     int,
  uses         int not null default 0,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users on delete cascade,
  token_hash   text not null unique,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index sessions_user on sessions (user_id);

-- Long-lived bearer tokens used by the desktop app.
create table device_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users on delete cascade,
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index device_tokens_user on device_tokens (user_id);

create table password_resets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz
);

create table videos (
  id           text primary key,
  workspace_id uuid not null references workspaces on delete cascade,
  owner_id     uuid not null references users on delete cascade,
  title        text not null,
  status       text not null default 'recording' check (status in ('recording', 'ready', 'failed')),
  privacy      text not null check (privacy in ('link', 'workspace', 'private')),
  secret       text not null,
  mime_type    text not null,
  ext          text not null,
  duration_ms  int,
  size_bytes   bigint,
  has_thumb    boolean not null default false,
  views        int not null default 0,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  archived_at  timestamptz
);
create index videos_workspace on videos (workspace_id, created_at desc);
create index videos_owner on videos (owner_id, created_at desc);

-- People (by email) who may watch a private video.
create table video_access (
  video_id   text not null references videos on delete cascade,
  email      text not null,
  created_at timestamptz not null default now(),
  primary key (video_id, email)
);
create index video_access_email on video_access (email);
