// Operator-selected real archive windows. No model and no Discord sender here.
import pg from "pg";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { state, assertPrivateState } from "./runtime.mjs";
import { snowflake, validateScope } from "./pilot-store.mjs";
import { validateHistoryPass, stageHistoryRequest } from "./pilot-history.mjs";

process.umask(0o077);
assertPrivateState(state);
const mode = process.argv[2];
if (!["stage", "status"].includes(mode) || (mode === "stage") !== Boolean(process.argv[3]))
  throw new Error("Use stage /private/selection.json or status");
const config = validateScope(JSON.parse(await readFile(join(state, "pilot.json"), "utf8")));
const connection = JSON.parse(
  await readFile(join(state, mode === "stage" ? "history-postgres.json" : "postgres.json"), "utf8"),
);
if (
  connection.host !== "127.0.0.1" ||
  connection.user !== (mode === "stage" ? "mudfut_history_reader" : "mudfut_pilot")
)
  throw new Error("Use the existing dedicated loopback archive/pilot role");
const db = new pg.Client({
  ...connection,
  statement_timeout: 10000,
  connectionTimeoutMillis: 10000,
});
await db.connect();
try {
  await db.query("BEGIN READ ONLY");
  if (mode === "status") {
    const exists = (await db.query("SELECT to_regclass('public.pilot_history_episodes') AS name"))
      .rows[0].name;
    console.log(
      JSON.stringify(
        exists
          ? (
              await db.query(`SELECT id,pass_id,status,
      jsonb_array_length(manifest->'sourceIds') AS planned_messages,
      cardinality(read_ids) AS reviewed_messages,cardinality(context_ids) AS context_messages,
      excluded,work_id,completed_at FROM pilot_history_episodes ORDER BY created_at,id`)
            ).rows
          : [],
        null,
        2,
      ),
    );
    await db.query("COMMIT");
  } else {
    const selectionPath = resolve(process.argv[3]);
    assertPrivateState(selectionPath);
    const selection = JSON.parse(await readFile(selectionPath, "utf8"));
    if (
      !selection ||
      !Array.isArray(selection.windows) ||
      !selection.windows.length ||
      selection.windows.length > 6
    )
      throw new Error("Select 1–6 conversation windows");
    const episodes = [],
      snapshots = [];
    for (const w of selection.windows) {
      if (
        !w ||
        typeof w !== "object" ||
        Array.isArray(w) ||
        !snowflake(w.guildId) ||
        !snowflake(w.channelId) ||
        typeof w.start !== "string" ||
        typeof w.end !== "string" ||
        !Number.isFinite(Date.parse(w.start)) ||
        !Number.isFinite(Date.parse(w.end)) ||
        Date.parse(w.end) < Date.parse(w.start) ||
        Date.parse(w.end) - Date.parse(w.start) > 45 * 60000
      )
        throw new Error(
          "Window needs valid guild/channel IDs and dates spanning at most 45 minutes",
        );
      const sql = `SELECT m.message_id,m.author_id,m.author_display_name,m.content,m.created_at,m.reply_to_message_id
        FROM messages m WHERE m.guild_id=$1 AND m.channel_id=$2 AND m.deleted_at IS NULL
        AND m.content IS NOT NULL AND (m.thread_id IS NULL OR m.thread_id=m.channel_id)`;
      const focus = (
        await db.query(
          sql + " AND m.created_at BETWEEN $3 AND $4 ORDER BY m.created_at,m.message_id LIMIT 25",
          [w.guildId, w.channelId, w.start, w.end],
        )
      ).rows;
      if (!focus.length || focus.length > 24)
        throw new Error("Choose an intact window of 1–24 messages; no silent truncation");
      const before = (
        await db.query(
          sql +
            " AND (m.created_at,m.message_id)<($3::timestamptz,$4::text) ORDER BY m.created_at DESC,m.message_id DESC LIMIT 4",
          [w.guildId, w.channelId, focus[0].created_at, focus[0].message_id],
        )
      ).rows.reverse();
      const last = focus.at(-1);
      const after = (
        await db.query(
          sql +
            " AND (m.created_at,m.message_id)>($3::timestamptz,$4::text) ORDER BY m.created_at,m.message_id LIMIT 4",
          [w.guildId, w.channelId, last.created_at, last.message_id],
        )
      ).rows;
      episodes.push({
        key: w.key,
        label: w.label,
        guildId: w.guildId,
        channelId: w.channelId,
        sourceIds: focus.map((m) => m.message_id),
        contextIds: [...before, ...after].map((m) => m.message_id),
      });
      snapshots.push({ window: w, before, messages: focus, after });
    }
    await db.query("COMMIT");
    const pass = validateHistoryPass({ id: selection.id, episodes }, config);
    const snapshotPath = join(state, `history-selection-${pass.id}.json`);
    try {
      await writeFile(snapshotPath, JSON.stringify({ pass, snapshots }, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const saved = JSON.parse(await readFile(snapshotPath, "utf8"));
      if (JSON.stringify(validateHistoryPass(saved.pass, config)) !== JSON.stringify(pass))
        throw new Error("Existing selection snapshot differs; preserve it before selecting again");
    }
    await stageHistoryRequest(state, pass, config);
    console.log(
      JSON.stringify(
        {
          passId: pass.id,
          episodes: pass.episodes.length,
          selectedMessages: episodes.reduce((n, e) => n + e.sourceIds.length, 0),
          surroundingMessages: episodes.reduce((n, e) => n + e.contextIds.length, 0),
          status: "selected, not yet read; the existing worker commits learning",
        },
        null,
        2,
      ),
    );
  }
} finally {
  await db.end();
}
