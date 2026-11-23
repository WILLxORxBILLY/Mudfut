// Read-only member positions from extracted statements. No opt-out, eligibility,
// or disclosure gate: a command returns the statements, and the model constructs
// the profile from those statements alone.

const SNOWFLAKE = /^[0-9]{17,20}$/u;

function clip(value, max) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function limitOf(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`Limit must be an integer from 1 to ${max}`);
  return value;
}

export function memberPositionsInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid member position request");
  const allowed = ["member", "topic", "limit", "guildId", "botId"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error("Invalid member position request");
  const member = input.member === undefined ? null : String(input.member).trim();
  const topic = input.topic === undefined ? null : String(input.topic).trim();
  if (member !== null && (member.length < 1 || member.length > 100))
    throw new Error("Member must be a Discord id or a name of 1–100 characters");
  if (topic !== null && (topic.length < 1 || topic.length > 200))
    throw new Error("Topic must be 1–200 characters");
  return { member, topic, limit: limitOf(input.limit, member ? 24 : 80, member ? 40 : 100) };
}

function statementRow(row) {
  return {
    memberId: row.memberId,
    name: row.name ?? null,
    topic: clip(row.topic, 200),
    proposition: clip(row.proposition, 400),
    quote: clip(row.quote, 280),
    kind: row.kind,
    messageId: row.messageId,
    at: row.at,
  };
}

export async function memberPositions(history, input) {
  const request = memberPositionsInput(input);
  if (!history || !input.guildId) throw new Error("Member positions require the archive");
  const guidance =
    "Construct the profile and positions only from these statements. Keep inferences separate from what was said. Cite messageId. A missing statement is not a position.";
  if (!request.member) {
    if (request.topic) {
      const { rows } = await history.query(
        `SELECT s.subject_member_id AS "memberId", names.author_display_name AS name,
           s.normalized_topic AS topic, s.normalized_proposition AS proposition,
           s.exact_quote AS quote, s.statement_kind::text AS kind,
           s.source_message_id AS "messageId",
           to_char(s.source_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM v2_statements s
         LEFT JOIN LATERAL (
           SELECT author_display_name FROM messages m
           WHERE m.guild_id = s.guild_id AND m.author_id = s.subject_member_id
             AND m.deleted_at IS NULL AND m.author_display_name IS NOT NULL
           ORDER BY m.created_at DESC LIMIT 1
         ) names ON true
         WHERE s.guild_id = $1
           AND to_tsvector('english', concat_ws(' ', s.normalized_topic, s.normalized_proposition, s.exact_quote))
             @@ websearch_to_tsquery('english', $2)
         ORDER BY s.source_occurred_at DESC NULLS LAST, s.statement_id
         LIMIT $3`,
        [input.guildId, request.topic, request.limit],
      );
      return {
        scope: "topic",
        topic: request.topic,
        returned: rows.length,
        statements: rows.map(statementRow),
        guidance,
      };
    }
    const { rows } = await history.query(
      `WITH names AS (
         SELECT DISTINCT ON (author_id) author_id, author_display_name
         FROM messages
         WHERE guild_id = $1 AND deleted_at IS NULL
           AND ($2::text IS NULL OR author_id <> $2)
           AND author_display_name IS NOT NULL
         ORDER BY author_id, created_at DESC
       ),
       counts AS (
         SELECT subject_member_id, count(*)::int AS statements
         FROM v2_statements WHERE guild_id = $1 GROUP BY 1
       )
       SELECT n.author_id AS id, n.author_display_name AS name,
         COALESCE(c.statements, 0)::int AS statements
       FROM names n
       LEFT JOIN counts c ON c.subject_member_id = n.author_id
       ORDER BY statements DESC, name
       LIMIT $3`,
      [input.guildId, input.botId ?? null, request.limit],
    );
    return { scope: "roster", returned: rows.length, members: rows, guidance };
  }

  const exactId = SNOWFLAKE.test(request.member);
  const { rows: matches } = exactId
    ? await history.query(
        `SELECT $2::text AS id,
           (SELECT author_display_name FROM messages m
            WHERE m.guild_id = $1 AND m.author_id = $2 AND m.deleted_at IS NULL
              AND m.author_display_name IS NOT NULL
            ORDER BY m.created_at DESC LIMIT 1) AS name`,
        [input.guildId, request.member],
      )
    : await history.query(
        `SELECT author_id AS id, author_display_name AS name FROM (
           SELECT DISTINCT ON (author_id) author_id, author_display_name
           FROM messages
           WHERE guild_id = $1 AND deleted_at IS NULL AND author_display_name IS NOT NULL
             AND ($2::text IS NULL OR author_id <> $2)
           ORDER BY author_id, created_at DESC
         ) current
         WHERE lower(author_display_name) = lower($3)
            OR author_display_name ILIKE $4 ESCAPE '\\'
         ORDER BY (lower(author_display_name) = lower($3)) DESC, author_display_name
         LIMIT 8`,
        [
          input.guildId,
          input.botId ?? null,
          request.member,
          `%${request.member.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`,
        ],
      );
  const candidates = matches.filter((row) => row.id && (exactId || row.name));
  if (!exactId && candidates.length !== 1) {
    return {
      scope: candidates.length ? "ambiguous" : "unmatched",
      query: request.member,
      members: candidates.map((row) => ({ id: row.id, name: row.name })),
      guidance: candidates.length
        ? "Ask which member before constructing a profile."
        : "No member matched that name. Call member_positions without a member to see the roster.",
    };
  }
  const member = exactId ? { id: request.member, name: candidates[0]?.name ?? null } : candidates[0];
  const summary = (
    await history.query(
      `SELECT count(*)::int AS n FROM v2_statements
       WHERE guild_id = $1 AND subject_member_id = $2`,
      [input.guildId, member.id],
    )
  ).rows[0] ?? { n: 0 };
  const params = [input.guildId, member.id, request.limit];
  const sql = request.topic
    ? `SELECT s.subject_member_id AS "memberId",
         s.normalized_topic AS topic, s.normalized_proposition AS proposition,
         s.exact_quote AS quote, s.statement_kind::text AS kind,
         s.source_message_id AS "messageId",
         to_char(s.source_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
       FROM v2_statements s
       WHERE s.guild_id = $1 AND s.subject_member_id = $2
         AND to_tsvector('english', concat_ws(' ', s.normalized_topic, s.normalized_proposition, s.exact_quote))
           @@ websearch_to_tsquery('english', $4)
       ORDER BY s.source_occurred_at DESC NULLS LAST, s.statement_id
       LIMIT $3`
    : `WITH scoped AS (
         SELECT s.normalized_topic AS topic, s.normalized_proposition AS proposition,
           s.exact_quote AS quote, s.statement_kind::text AS kind,
           s.source_message_id AS "messageId",
           to_char(s.source_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
           row_number() OVER (ORDER BY s.source_occurred_at NULLS LAST, s.statement_id) AS rn,
           count(*) OVER () AS total
         FROM v2_statements s
         WHERE s.guild_id = $1 AND s.subject_member_id = $2
       )
       SELECT $2::text AS "memberId", topic, proposition, quote, kind, "messageId", at
       FROM scoped
       WHERE rn = 1 OR rn = total OR rn % GREATEST(total / GREATEST($3, 1), 1) = 0
       ORDER BY at DESC NULLS LAST
       LIMIT $3`;
  if (request.topic) params.push(request.topic);
  const { rows } = await history.query(sql, params);
  const statements = rows.map((row) => statementRow({ ...row, name: member.name, memberId: member.id }));
  return {
    scope: "member",
    member,
    statementCount: summary.n ?? statements.length,
    returned: statements.length,
    truncated: (summary.n ?? statements.length) > statements.length,
    statements,
    guidance,
  };
}
