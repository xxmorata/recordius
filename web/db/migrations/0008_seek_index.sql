-- Recordings made by desktop apps before 1.0.14 are fragmented MP4 without a total duration or seek index:
-- Firefox shows only the first chunk and can't jump ahead. The server adds the index (lib/mp4-index.ts),
-- writes the repaired file next to the original and points the video at it.
alter table videos add column seek_index text not null default 'pending' check (seek_index in ('pending', 'ready', 'failed'));
alter table videos add column seek_index_attempts int not null default 0;
alter table videos add column seek_index_started_at timestamptz;
alter table videos add column file_path text;
create index videos_seek_index_pending on videos (workspace_id) where status = 'ready' and seek_index = 'pending';

-- Files replaced by a repaired copy stay for a while (links already handed out keep working), then go.
create table stale_files (
  pathname     text primary key,
  delete_after timestamptz not null
);
create index stale_files_due on stale_files (delete_after);
