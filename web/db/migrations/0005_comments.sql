-- Timestamped comments. Only people with account-level access (owner, workspace members, invited emails) can read or write them.
create table video_comments (
  id         uuid primary key default gen_random_uuid(),
  video_id   text not null references videos on delete cascade,
  user_id    uuid not null references users on delete cascade,
  body       text not null check (length(body) between 1 and 4000),
  at_ms      int check (at_ms >= 0),            -- position on the (trimmed) timeline, or null for a general comment
  created_at timestamptz not null default now()
);
create index video_comments_video on video_comments (video_id, created_at);
