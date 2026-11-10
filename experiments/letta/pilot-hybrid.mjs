// Corpus retrieval over the existing chunk index. This reads chunks and
// chunk_messages only. It does not read member-memory, consent, or web-search tables.

const EMBEDDING_URL = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

export function vectorLiteral(values) {
  if (
    !Array.isArray(values) ||
    values.length !== EMBEDDING_DIMENSIONS ||
    values.some((value) => typeof value !== "number" || !Number.isFinite(value))
  )
    return null;
  return `[${values.join(",")}]`;
}

export async function embedArchiveQuery(query, fetchImpl = globalThis.fetch) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key || !query?.trim()) return null;
  try {
    const response = await fetchImpl(EMBEDDING_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: query,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return vectorLiteral(body?.data?.[0]?.embedding);
  } catch {
    return null;
  }
}

export function semanticArchiveSql(hasEmbedding) {
  const dense = hasEmbedding
    ? `dense AS (
        SELECT nearest.id, nearest.rank FROM (
          SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $1::vector, c.id) AS rank
          FROM chunks c
          WHERE c.guild_id = $2
            AND c.invalidated_at IS NULL
            AND c.embedding IS NOT NULL
            AND ($3::text[] IS NULL OR c.channel_id = ANY($3))
          ORDER BY c.embedding <=> $1::vector, c.id
          LIMIT 40
        ) nearest
      )`
    : `dense AS (
        SELECT NULL::text AS id, NULL::bigint AS rank WHERE false
      )`;
  return `WITH ${dense},
    lexical AS (
      SELECT ranked.id, ranked.rank FROM (
        SELECT c.id,
          row_number() OVER (ORDER BY ts_rank_cd(c.search_vector, plain.q) DESC, c.id) AS rank
        FROM chunks c
        CROSS JOIN LATERAL (SELECT websearch_to_tsquery('english', $4) AS q) plain
        WHERE c.guild_id = $2
          AND c.invalidated_at IS NULL
          AND plain.q IS NOT NULL
          AND c.search_vector @@ plain.q
          AND ($3::text[] IS NULL OR c.channel_id = ANY($3))
        ORDER BY ts_rank_cd(c.search_vector, plain.q) DESC, c.id
        LIMIT 40
      ) ranked
    ),
    fused AS (
      SELECT id, sum(1.0 / (60 + rank)) AS score
      FROM (
        SELECT id, rank FROM dense
        UNION ALL
        SELECT id, rank FROM lexical
      ) ranked
      WHERE id IS NOT NULL
      GROUP BY id
      ORDER BY score DESC, id
      LIMIT $5
    )
    SELECT cm.message_id AS id, c.guild_id AS "guildId", c.channel_id AS "channelId",
      to_char(msg.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM fused f
    JOIN chunks c ON c.id = f.id
    JOIN LATERAL (
      SELECT message_id FROM chunk_messages m
      WHERE m.chunk_id = f.id
      ORDER BY m.ordinal
      LIMIT 1
    ) cm ON true
    JOIN messages msg ON msg.message_id = cm.message_id
      AND msg.guild_id = c.guild_id
      AND msg.deleted_at IS NULL
      AND msg.content IS NOT NULL
      AND ($6::text[] IS NULL OR msg.author_id = ANY($6))
      AND ($7::timestamptz IS NULL OR msg.created_at >= $7)
      AND ($8::timestamptz IS NULL OR msg.created_at < $8)
      AND ($9::boolean IS FALSE OR msg.thread_id IS NULL)
    ORDER BY f.score DESC, cm.message_id`;
}

export async function semanticArchiveMessages(history, input, fetchImpl = globalThis.fetch) {
  if (!history || !input?.guildId || !input.query?.trim()) return [];
  const embedding = await embedArchiveQuery(input.query, fetchImpl);
  try {
    const { rows } = await history.query(semanticArchiveSql(embedding !== null), [
      embedding,
      input.guildId,
      input.channelIds ?? null,
      input.query,
      input.limit ?? 8,
      input.authorIds ?? null,
      input.after ?? null,
      input.before ?? null,
      input.excludeThreads === true,
    ]);
    return rows.filter((row) => row?.id && row.guildId && row.channelId);
  } catch {
    return [];
  }
}
