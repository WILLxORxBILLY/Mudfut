-- A schema contract for a NEW archive database. Do not apply it over an existing
-- ingestion system or assume this captures a complete Discord server.
CREATE TABLE messages (
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  thread_id text,
  message_id text NOT NULL,
  author_id text NOT NULL,
  author_display_name text NOT NULL,
  content text,
  content_hash text NOT NULL,
  reply_to_message_id text,
  created_at timestamptz NOT NULL,
  edited_at timestamptz,
  deleted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, message_id)
);
CREATE INDEX messages_channel_time ON messages(guild_id, channel_id, created_at, message_id);
CREATE INDEX messages_history_chronology ON messages
  (guild_id, channel_id, created_at, (message_id::numeric)) INCLUDE (message_id)
  WHERE deleted_at IS NULL AND content IS NOT NULL
    AND (thread_id IS NULL OR thread_id=channel_id);
