import { archiveTool } from "./pilot-discord.mjs";
import { archiveDiscussions } from "./pilot-discussions.mjs";
import { sourceRecord } from "./pilot-store.mjs";

const authority =
  "Historical-archive replay: configured read-only PostgreSQL archive, not freshly validated Discord originals.";

export function historyMessage(row) {
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.guildId !== "string" ||
    typeof row.channelId !== "string" ||
    typeof row.authorId !== "string" ||
    typeof row.content !== "string" ||
    typeof row.createdAt !== "string"
  )
    throw new Error("Invalid historical archive source row");
  return {
    id: row.id,
    type: row.replyTo ? 19 : 0,
    channel_id: row.channelId,
    author: { id: row.authorId, username: row.authorName ?? "Unknown member" },
    content: row.content,
    timestamp: row.createdAt,
    edited_timestamp: row.editedAt ?? null,
    message_reference: row.replyTo ? { message_id: row.replyTo } : undefined,
  };
}

const sourceColumns = `m.message_id AS id,m.guild_id AS "guildId",m.channel_id AS "channelId",
  m.author_id AS "authorId",m.author_display_name AS "authorName",m.content,
  to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  CASE WHEN m.edited_at IS NULL THEN NULL ELSE to_char(m.edited_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "editedAt",
  m.reply_to_message_id AS "replyTo"`;

const historicalCoverage = {
  authority,
  sourceFreshness: "No Discord fetch was attempted during this replay.",
  corpusCoverage:
    "Historical archive selection is bounded and read-only; absence is not proof of no Discord message or current source validity.",
};

export function historyArchive(history, { botId = "444444444444444444" } = {}) {
  const rowFor = async (channelId, id) =>
    (
      await history.query(
        `SELECT ${sourceColumns} FROM messages m
         WHERE m.message_id=$1 AND m.channel_id=$2 AND m.deleted_at IS NULL
           AND m.thread_id IS NULL AND m.content IS NOT NULL`,
        [id, channelId],
      )
    ).rows[0] ?? null;
  const discord = {
    async get(channelId, id) {
      const row = await rowFor(channelId, id);
      return row ? historyMessage(row) : null;
    },
    async recent(channelId, limit) {
      const rows = (
        await history.query(
          `SELECT ${sourceColumns} FROM messages m
           WHERE m.channel_id=$1 AND m.deleted_at IS NULL AND m.thread_id IS NULL
             AND m.content IS NOT NULL
           ORDER BY m.created_at DESC,m.message_id::numeric DESC LIMIT $2`,
          [channelId, limit],
        )
      ).rows;
      return rows.map(historyMessage);
    },
    async around(channelId, id) {
      const anchor = await rowFor(channelId, id);
      if (!anchor) return [];
      const rows = (
        await history.query(
          `SELECT ${sourceColumns} FROM messages m
           WHERE m.channel_id=$1 AND m.deleted_at IS NULL AND m.thread_id IS NULL
             AND m.content IS NOT NULL
             AND m.created_at BETWEEN $2::timestamptz-interval '30 minutes'
               AND $2::timestamptz+interval '30 minutes'
           ORDER BY m.created_at,m.message_id::numeric LIMIT 100`,
          [channelId, anchor.createdAt],
        )
      ).rows;
      return rows.map(historyMessage);
    },
  };
  const store = {
    // Archive search has no local writable cache in this evaluator. The fake
    // query surface supplies only archiveMatches after history has selected hits.
    db: {
      async query(sql, values) {
        if (sql.includes("FROM pilot_sources")) return { rows: [] };
        if (sql.includes("jsonb_to_recordset"))
          return {
            rows: JSON.parse(values[0]).map(({ id }) => ({
              id,
              lexicalMatch: true,
              stemmedMatch: true,
            })),
          };
        throw new Error("Unexpected evaluator-local archive query");
      },
    },
    ingest: async () => {},
    remove: async () => {},
  };
  const search = archiveTool(store, discord, { botId }, history);
  const discussions = archiveDiscussions(store, discord, { botId }, history);
  const normalize = (result) => ({ ...result, ...historicalCoverage });
  return {
    async sourceLookup(ids) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
        throw new Error("Invalid historical source lookup");
      if (!ids.length) return [];
      const rows = (
        await history.query(
          `SELECT ${sourceColumns} FROM messages m WHERE m.message_id=ANY($1::text[])
           AND m.deleted_at IS NULL AND m.thread_id IS NULL AND m.content IS NOT NULL`,
          [ids],
        )
      ).rows;
      const sources = new Map(
        rows.map((row) => [row.id, sourceRecord(historyMessage(row), row.guildId, row.channelId)]),
      );
      const missing = ids.filter((id) => !sources.has(id));
      if (missing.length)
        throw new Error(`Historical archive lacks source(s): ${missing.slice(0, 8).join(", ")}`);
      return ids.map((id) => sources.get(id));
    },
    async availableSourceIds(ids) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
        throw new Error("Invalid historical source availability query");
      const result = new Set();
      for (let offset = 0; offset < ids.length; offset += 1000) {
        const rows = (
          await history.query(
            `SELECT message_id FROM messages WHERE message_id=ANY($1::text[])
             AND deleted_at IS NULL AND thread_id IS NULL AND content IS NOT NULL`,
            [ids.slice(offset, offset + 1000)],
          )
        ).rows;
        rows.forEach((row) => result.add(row.message_id));
      }
      return result;
    },
    async search(input) {
      return normalize(await search(input));
    },
    discussions: {
      async browseArchive(input) {
        return normalize(await discussions.browseArchive(input));
      },
      async readDiscussion(input) {
        return normalize(await discussions.readDiscussion(input));
      },
      async findChronologicalGap(intervals, knownIds) {
        const gap = await discussions.findChronologicalGap(intervals, knownIds);
        return gap ? { ...gap, authority } : null;
      },
    },
  };
}
