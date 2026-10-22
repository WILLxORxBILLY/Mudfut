import { createHash } from "node:crypto";

const snowflake = (value) => typeof value === "string" && /^[1-9][0-9]{16,19}$/.test(value);
const plainObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const required = (value, keys, name) => {
  if (
    !plainObject(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  )
    throw new Error(`${name} has unexpected fields`);
};
const date = (value, name) => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value);
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error(`${name} must be a date`);
  return new Date(value);
};

// This deliberately accepts an explicit, bounded episode instead of a retired historyScope.
export function validateResearchManifest(value) {
  required(value, ["id", "guildId", "channelId", "start", "end", "sourceIds"], "Research manifest");
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(value.id))
    throw new Error("Research manifest needs a stable lower-case id");
  if (!snowflake(value.guildId) || !snowflake(value.channelId))
    throw new Error("Research manifest needs guild and channel snowflakes");
  const start = date(value.start, "Research manifest start"),
    end = date(value.end, "Research manifest end");
  if (end <= start || end - start > 45 * 60_000)
    throw new Error("Research manifest must describe an episode of at most 45 minutes");
  if (
    !Array.isArray(value.sourceIds) ||
    !value.sourceIds.length ||
    value.sourceIds.length > 24 ||
    value.sourceIds.some((id) => !snowflake(id)) ||
    new Set(value.sourceIds).size !== value.sourceIds.length
  )
    throw new Error("Research manifest needs 1-24 unique source snowflakes");
  return Object.freeze({ ...value, sourceIds: Object.freeze([...value.sourceIds]) });
}

export function assertResearchArchiveAuthority(credentials) {
  if (
    !plainObject(credentials) ||
    credentials.host !== "127.0.0.1" ||
    credentials.user !== "mudfut_history_reader"
  )
    throw new Error("Research export requires the configured loopback read-only archive role");
}

export function researchEpisodeQuery(manifest) {
  const value = validateResearchManifest(manifest);
  return {
    text: `SELECT m.message_id,m.author_id,m.author_display_name,m.content,m.created_at,m.reply_to_message_id
      FROM messages m WHERE m.guild_id=$1 AND m.channel_id=$2 AND m.message_id=ANY($3::text[])
      AND m.deleted_at IS NULL AND m.thread_id IS NULL AND m.content IS NOT NULL
      AND m.created_at BETWEEN $4 AND $5 ORDER BY m.created_at,m.message_id`,
    values: [value.guildId, value.channelId, value.sourceIds, value.start, value.end],
  };
}

function normalizeSource(row, manifest) {
  if (!plainObject(row) || !snowflake(row.message_id) || !snowflake(row.author_id))
    throw new Error("Archive returned an invalid source row");
  if (typeof row.content !== "string" || !row.content.trim())
    throw new Error("Archive returned an empty source");
  const createdAt = date(row.created_at, "Archive source timestamp");
  if (createdAt < new Date(manifest.start) || createdAt > new Date(manifest.end))
    throw new Error("Archive source falls outside its manifest window");
  return {
    id: row.message_id,
    authorId: row.author_id,
    authorDisplayName: typeof row.author_display_name === "string" ? row.author_display_name : null,
    content: row.content,
    createdAt: createdAt.toISOString(),
    replyToMessageId: snowflake(row.reply_to_message_id) ? row.reply_to_message_id : null,
  };
}

export function researchEpisodeReceipt(manifest, rows) {
  const value = validateResearchManifest(manifest);
  if (!Array.isArray(rows)) throw new Error("Archive results must be an array");
  const sources = rows.map((row) => normalizeSource(row, value));
  const expected = new Set(value.sourceIds);
  if (
    sources.length !== expected.size ||
    sources.some((source) => !expected.delete(source.id)) ||
    expected.size
  )
    throw new Error("Archive did not return exactly the manifest source IDs");
  const receipt = {
    format: "mudfut-research-episode-v1",
    manifest: value,
    sources,
  };
  return Object.freeze({
    ...receipt,
    sha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex"),
  });
}

export async function exportResearchEpisode(client, manifest) {
  const query = researchEpisodeQuery(manifest);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    return researchEpisodeReceipt(manifest, (await client.query(query.text, query.values)).rows);
  } finally {
    await client.query("ROLLBACK");
  }
}
