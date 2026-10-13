-- Rate limiting for sign-in, sign-up, invites and password resets. Keys are HMACs of the client IP or the
-- email address, so the table never holds either in clear text. Rows older than a day are deleted.
create table auth_attempts (
  id     bigserial primary key,
  scope  text not null,
  key    text not null,
  at     timestamptz not null default now()
);
create index auth_attempts_lookup on auth_attempts (scope, key, at);
