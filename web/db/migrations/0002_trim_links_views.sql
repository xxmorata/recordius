-- Trim, password/expiring links, custom thumbnails, uploads and per-viewer watch progress.

alter table videos
  add column trim_start_ms     int,
  add column trim_end_ms       int,
  add column link_password_hash text,
  add column link_expires_at   timestamptz,
  add column thumb_path        text,          -- custom thumbnail; null = the one the recorder made
  add column source            text not null default 'recording' check (source in ('recording', 'upload'));

-- One row per viewer and video. Signed-in viewers are identified by account, everyone else by an
-- anonymous cookie, so a refresh doesn't count as a new view.
create table video_views (
  video_id        text not null references videos on delete cascade,
  viewer_key      text not null,              -- 'u:<user id>' or 'a:<random cookie>'
  user_id         uuid references users on delete set null,
  max_position_ms int not null default 0,     -- furthest point reached (on the trimmed timeline)
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  primary key (video_id, viewer_key)
);
create index video_views_video on video_views (video_id, last_seen_at desc);
