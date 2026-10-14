-- Finding recordings that never finished (marked failed after a day) without scanning every video.
create index if not exists videos_recording on videos (created_at) where status = 'recording';
