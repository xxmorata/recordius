-- Failed password attempts on protected links, for rate limiting (rows older than a day are pruned).
create table unlock_attempts (
  video_id   text not null references videos on delete cascade,
  client_key text not null,        -- sha256 of the client IP
  at         timestamptz not null default now()
);
create index unlock_attempts_lookup on unlock_attempts (video_id, at);
