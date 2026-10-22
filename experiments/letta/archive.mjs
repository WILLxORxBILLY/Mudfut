import pg from "pg";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { state } from "./runtime.mjs";

export const ambient = [
  [
    "demo-101",
    "mira",
    "Mira",
    "For the observatory trip, let's take the train. I'm refusing to spend another Friday steering through traffic.",
  ],
  ["demo-102", "theo", "Theo", "Mira has finally declared war on cars."],
  ["demo-103", "mira", "Mira", "Fine, put that on my campaign poster."],
  [
    "demo-104",
    "rowan",
    "Rowan",
    "Last trip Theo called east west for twenty minutes. The compass has applied for a restraining order.",
  ],
  ["demo-105", "theo", "Theo", "One wrong turn and suddenly I'm Admiral Wrongway."],
  ["demo-106", "rowan", "Rowan", "You named yourself. It sticks."],
];
export const correction = [
  "demo-107",
  "mira",
  "Mira",
  "Small correction: I don't hate driving. I drive the supply van on Sundays. I meant take the train for the observatory Friday because parking there is a disaster.",
];

export function validateSearch(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !["query", "messageId"].includes(k))
  )
    throw new Error("Invalid archive input");
  if ((input.query !== undefined) === (input.messageId !== undefined)) {
    throw new Error("Supply exactly one of query or messageId");
  }
  if (
    input.query !== undefined &&
    (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200)
  )
    throw new Error("Query must be 1–200 characters");
  if (
    input.messageId !== undefined &&
    (typeof input.messageId !== "string" || !/^demo-\d{3}$/.test(input.messageId))
  )
    throw new Error("Invalid fixture source ID");
  return input;
}

export async function openArchive() {
  const config = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
  if (
    config.host !== "127.0.0.1" ||
    config.database !== "mudfut_fixture" ||
    config.user !== "mudfut_fixture"
  ) {
    throw new Error("Only the disposable fixture database is supported by this experiment");
  }
  return new pg.Pool({ ...config, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
}
export async function seed(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    message_id text PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL,
    author_id text NOT NULL, author_name text NOT NULL, content text NOT NULL,
    created_at timestamptz NOT NULL, deleted_at timestamptz
  )`);
  for (const row of ambient) await insertSource(pool, row);
  await pool.query(`INSERT INTO messages VALUES ('demo-999','fixture-guild','staff','staff','Staff',
    'PRIVATE CANARY: teal narwhal',now(),NULL) ON CONFLICT DO NOTHING`);
}
export async function insertSource(pool, [id, author, name, content]) {
  await pool.query(
    `INSERT INTO messages(message_id,guild_id,channel_id,author_id,author_name,content,created_at)
    VALUES ($1,'fixture-guild','lobby',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [
      id,
      author,
      name,
      content,
      new Date(Date.parse("2026-10-15T18:00:00Z") + (Number(id.slice(-3)) - 101) * 60_000),
    ],
  );
}
export async function searchArchive(pool, input) {
  validateSearch(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await client.query(
      `SELECT message_id,author_id,author_name,content,created_at
      FROM messages WHERE guild_id=$1 AND channel_id=ANY($2::text[]) AND deleted_at IS NULL
      AND ($3::text IS NULL OR message_id=$3)
      AND ($4::text IS NULL OR to_tsvector('english',content || ' ' || author_name)
          @@ websearch_to_tsquery('english',$4)) ORDER BY created_at,message_id LIMIT 12`,
      ["fixture-guild", ["lobby"], input.messageId ?? null, input.query ?? null],
    );
    await client.query("COMMIT");
    return {
      dataset: "synthetic fixture, not Discord history",
      sources: result.rows.map((row) => ({
        ...row,
        source: `fixture://lobby/${row.message_id}`,
      })),
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
