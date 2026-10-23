import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentHistoryEpisode,
  validateHistoryPass,
  validateHistoryAutomation,
  selectAutomaticHistoryWindow,
  historyQueue,
  textBearingHistorySources,
} from "./pilot-history.mjs";

const guildId = "111111111111111111",
  channelId = "222222222222222222";
const firstId = 555555555555555501n;
const settings = {
  id: "social-learning",
  enabled: true,
  channels: [{ guildId, channelId, start: "2025-01-01T00:00:00Z", end: "2025-12-31T00:00:00Z" }],
  cooldownSeconds: 0,
};
const row = (i, minutes) => ({
  message_id: String(firstId + BigInt(i)),
  created_at: new Date(Date.UTC(2025, 0, 2, 0, minutes)),
});

test("historical knowledge registers only messages with text evidence", () => {
  const keep = { id: "text", content: "  sourced claim  " };
  const emptyTarget = { id: "attachment-only", content: "" };
  const emptyContext = { id: "whitespace-only", content: " \n " };
  assert.deepEqual(
    textBearingHistorySources({
      rows: [{ source: keep }, { source: emptyTarget }],
      context: { surroundingMessages: [emptyContext] },
    }),
    [keep],
  );
});

test("automation requires explicit chronological channels and retains per-turn bounds without legacy scope gates", () => {
  const value = validateHistoryAutomation(settings);
  assert.equal(value.maxMessages, 24);
  assert.equal(value.windowMinutes, 30);
  for (const bad of [
    { ...settings, maxMessages: 25 },
    { ...settings, windowMinutes: 46 },
    { ...settings, channels: [...settings.channels, ...settings.channels] },
    { ...settings, channels: [{ ...settings.channels[0], start: "invalid" }] },
    { ...settings, channels: [{ ...settings.channels[0], end: "2024-01-01" }] },
    { ...settings, unexpected: true },
  ])
    assert.throws(() => validateHistoryAutomation(bad));
  const pass = {
    id: "new",
    episodes: [
      {
        key: "a",
        label: "A real dated episode",
        guildId,
        channelId,
        sourceIds: [String(firstId)],
        contextIds: [],
      },
    ],
  };
  assert.deepEqual(
    validateHistoryPass(pass, { historyScope: [] }),
    pass,
    "retired allowlists do not exclude real sources",
  );
});

test("automatic windows preserve chronology, cap workload and stop at conversation gaps", async () => {
  const queries = [];
  const history = {
    query: async (sql, args) => {
      queries.push({ sql, args });
      return {
        rows:
          queries.length === 1
            ? [row(0, 0), row(1, 2), row(2, 3), row(3, 25)]
            : [row(-1, -1), row(3, 25)],
      };
    },
  };
  const channel = validateHistoryAutomation(settings).channels[0];
  const result = await selectAutomaticHistoryWindow(
    history,
    channel,
    { at: channel.start, id: "0" },
    { maxMessages: 24, windowMinutes: 30 },
  );
  assert.deepEqual(
    result.targets.map((r) => r.message_id),
    [0, 1, 2].map((n) => String(firstId + BigInt(n))),
  );
  assert.equal(result.cursor.id, String(firstId + 2n));
  assert.equal(queries[0].args.at(-1), 24);
  assert.ok(queries[0].sql.includes("created_at,message_id::numeric"));
  assert.equal(result.contextIds.length, 2);
  let calls = 0;
  const bounded = await selectAutomaticHistoryWindow(
    {
      query: async () => ({
        rows: ++calls === 1 ? [row(0, 0), row(1, 14), row(2, 28), row(3, 42)] : [],
      }),
    },
    channel,
    { at: channel.start, id: "0" },
    { maxMessages: 24, windowMinutes: 30 },
  );
  assert.equal(
    bounded.targets.length,
    3,
    "dense ongoing discussion still respects wall-clock window cap",
  );
});

function database() {
  const cursors = new Map(),
    passes = new Map(),
    episodes = new Map(),
    queries = [];
  return {
    cursors,
    passes,
    episodes,
    queries,
    query: async (sql, args = []) => {
      queries.push(sql);
      if (sql.startsWith("INSERT INTO pilot_history_automation")) {
        if (!cursors.has(args[0]))
          cursors.set(args[0], {
            id: args[0],
            manifest: args[1],
            cursor_at: args[2],
            cursor_id: "0",
            exhausted: false,
          });
      } else if (sql === "SELECT manifest FROM pilot_history_automation WHERE id=$1")
        return { rows: [cursors.get(args[0])] };
      else if (sql.startsWith("SELECT * FROM pilot_history_automation"))
        return { rows: [...cursors.values()].filter((c) => !c.exhausted).slice(0, 1) };
      else if (sql.startsWith("SELECT * FROM pilot_history_episodes"))
        return { rows: [...episodes.values()].filter((e) => e.status === "queued").slice(0, 1) };
      else if (sql.startsWith("SELECT DISTINCT unnest"))
        return {
          rows: [...episodes.values()]
            .filter((e) => e.status === "done")
            .flatMap((e) => e.read_ids.map((id) => ({ id }))),
        };
      else if (sql.startsWith("INSERT INTO pilot_history_passes")) passes.set(args[0], args[1]);
      else if (sql.startsWith("INSERT INTO pilot_history_episodes"))
        episodes.set(args[0], {
          id: args[0],
          pass_id: args[1],
          manifest: args[2],
          status: "queued",
          read_ids: [],
        });
      else if (sql.startsWith("UPDATE pilot_history_automation"))
        Object.assign(cursors.get(args[0]), {
          cursor_at: args[1],
          cursor_id: args[2],
          exhausted: args[3],
        });
      else if (sql.includes("SET status='excluded'")) episodes.get(args[0]).status = "excluded";
      return { rows: [] };
    },
  };
}

test("automatic admission durably queues unread work, deduplicates completed targets and resumes without a second writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mudfut-auto-"));
  try {
    await writeFile(join(directory, "history-automation.json"), JSON.stringify(settings));
    const db = database(),
      records = [];
    // A prior manual receipt proves only the first target was actually read.
    db.episodes.set("manual:done", { status: "done", read_ids: [String(firstId)] });
    const archive = {
      query: async (sql) => ({
        rows: sql.includes("SELECT message_id,created_at FROM messages")
          ? [row(0, 0), row(1, 2)]
          : sql.includes("SELECT m.message_id")
            ? [{ message_id: String(firstId + 1n) }]
            : [],
      }),
    };
    let fetched = 0;
    const discord = {
      channel: async (id) => ({ id, guild_id: guildId, type: 0 }),
      recent: async () => [],
      get: async (_channel, id) => {
        fetched++;
        return {
          id,
          channel_id: channelId,
          author: { id: "333333333333333333", username: "Member" },
          type: 0,
          timestamp: "2025-01-02T00:02:00Z",
          content: "A conversation",
        };
      },
    };
    const store = { db, ingest: async () => {}, remove: async () => {} };
    const queue = () =>
      historyQueue(store, discord, {}, directory, async (record) => records.push(record), archive);
    const batch = await queue().next();
    assert.deepEqual(
      batch.rows.map((r) => r.id),
      [String(firstId + 1n)],
    );
    assert.equal(batch.replyTo, null);
    const episode = [...db.episodes.values()].find((e) => e.status === "queued");
    assert.deepEqual(episode.read_ids, [], "loading and selection cannot mark targets read");
    assert.equal([...db.cursors.values()][0].cursor_id, String(firstId + 1n));
    assert.deepEqual(records.find((r) => r.type === "history_automation_admitted").alreadyReadIds, [
      String(firstId),
    ]);
    assert.equal(
      (await queue().next()).historyEpisode,
      batch.historyEpisode,
      "restart resumes durable queued work",
    );
    assert.equal(db.passes.size, 1, "restart does not admit a duplicate pass while work is queued");
    assert.equal(fetched, 2);
    assert.ok(db.queries.indexOf("BEGIN") < db.queries.indexOf("COMMIT"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a live arrival yields before source refresh without committing a read receipt or cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mudfut-auto-yield-"));
  try {
    const db = database();
    db.episodes.set("manual:queued", {
      id: "manual:queued",
      pass_id: "manual",
      status: "queued",
      read_ids: [],
      manifest: {
        key: "queued",
        label: "Queued conversation",
        guildId,
        channelId,
        sourceIds: [String(firstId)],
        contextIds: [],
      },
    });
    let checks = 0,
      reads = 0;
    const queue = historyQueue(
      { db },
      {
        channel: async (id) => ({ id, guild_id: guildId, type: 0 }),
        recent: async () => {
          reads++;
          return [];
        },
      },
      {},
      directory,
      async () => {},
      {
        query: async () => ({ rows: [{ message_id: String(firstId) }] }),
      },
      { shouldYield: async () => ++checks >= 3 },
    );
    assert.equal(await queue.next(), null);
    assert.equal(reads, 0);
    assert.deepEqual(db.episodes.get("manual:queued").read_ids, []);
    assert.equal(db.cursors.size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "PostgreSQL automation deduplicates committed deferred receipts but retries unreviewed deferred targets",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () => {
    const { readFile } = await import("node:fs/promises");
    const { randomUUID } = await import("node:crypto");
    const { default: pg } = await import("pg");
    const { state } = await import("./runtime.mjs");
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const admin = new pg.Client(credentials);
    await admin.connect();
    const name = "mudfut_automation_check_" + randomUUID().replaceAll("-", "");
    const directory = await mkdtemp(join(tmpdir(), "mudfut-auto-postgres-"));
    let db;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      db = new pg.Client({ ...credentials, database: name });
      await db.connect();
      await db.query(`CREATE TABLE messages(guild_id text,channel_id text,message_id text,created_at timestamptz,
      deleted_at timestamptz,content text,thread_id text);
      CREATE TABLE pilot_history_passes(id text PRIMARY KEY,manifest jsonb);
      CREATE TABLE pilot_history_episodes(id text PRIMARY KEY,pass_id text,manifest jsonb,
        status text DEFAULT 'queued',read_ids text[] DEFAULT '{}',context_ids text[] DEFAULT '{}',excluded jsonb);`);
      const original = row(0, 0),
        next = row(1, 2);
      for (const message of [original, next])
        await db.query(
          "INSERT INTO messages(guild_id,channel_id,message_id,created_at,content) VALUES($1,$2,$3,$4,'A conversation')",
          [guildId, channelId, message.message_id, message.created_at],
        );
      await db.query(
        "INSERT INTO pilot_history_episodes(id,status,read_ids) VALUES('manual:committed','deferred',$1)",
        [[original.message_id]],
      );
      await db.query(
        "INSERT INTO pilot_history_episodes(id,status,manifest) VALUES('manual:unreviewed','deferred',$1)",
        [{ sourceIds: [next.message_id] }],
      );
      await writeFile(join(directory, "history-automation.json"), JSON.stringify(settings));
      const store = { db, ingest: async () => {}, remove: async () => {} };
      const discord = {
        channel: async (id) => ({ id, guild_id: guildId, type: 0 }),
        recent: async () => [],
        get: async (_channel, id) => ({
          id,
          channel_id: channelId,
          author: { id: "333333333333333333", username: "Member" },
          type: 0,
          timestamp: "2025-01-02T00:02:00Z",
          content: "A conversation",
        }),
      };
      const queue = () => historyQueue(store, discord, {}, directory, async () => {}, db);
      const batch = await queue().next();
      assert.deepEqual(
        batch.rows.map((item) => item.id),
        [next.message_id],
      );
      assert.deepEqual(
        (
          await db.query("SELECT read_ids FROM pilot_history_episodes WHERE id=$1", [
            batch.historyEpisode,
          ])
        ).rows[0].read_ids,
        [],
      );
      assert.equal(
        (await db.query("SELECT cursor_id FROM pilot_history_automation")).rows[0].cursor_id,
        next.message_id,
      );
      assert.equal((await queue().next()).historyEpisode, batch.historyEpisode);
      await db.query("UPDATE pilot_history_episodes SET status='done',read_ids=$2 WHERE id=$1", [
        batch.historyEpisode,
        [next.message_id],
      ]);
      assert.equal(await queue().next(), null);
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM pilot_history_passes")).rows[0].n,
        1,
      );
      assert.equal(
        (await db.query("SELECT exhausted FROM pilot_history_automation")).rows[0].exhausted,
        true,
      );
      await writeFile(
        join(directory, "history-automation.json"),
        JSON.stringify({ ...settings, maxMessages: 12 }),
      );
      assert.equal(await queue().next(), null, "invalid automation range is durably quarantined");
      assert.equal(
        (await db.query("SELECT manifest FROM pilot_history_automation")).rows[0].manifest
          .maxMessages,
        24,
      );
      const rejected = (await db.query("SELECT detail FROM pilot_history_admission_failures")).rows;
      assert.equal(rejected.length, 1);
      assert.match(rejected[0].detail.message, /different immutable range/);
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("historical context fetch yields between Discord network calls when a live message arrives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mudfut-auto-midfetch-"));
  try {
    const db = database();
    const ids = [String(firstId), String(firstId + 1n)];
    db.episodes.set("manual:queued", {
      id: "manual:queued",
      pass_id: "manual",
      status: "queued",
      read_ids: [],
      manifest: {
        key: "queued",
        label: "Queued conversation",
        guildId,
        channelId,
        sourceIds: ids,
        contextIds: [],
      },
    });
    let urgent = false,
      recent = 0,
      extraFetches = 0,
      ingested = 0;
    const queue = historyQueue(
      {
        db,
        ingest: async () => {
          ingested++;
        },
      },
      {
        channel: async (id) => ({ id, guild_id: guildId, type: 0 }),
        recent: async () => {
          recent++;
          urgent = true;
          return [];
        },
        around: async () => {
          extraFetches++;
          return [];
        },
        get: async () => {
          extraFetches++;
          return null;
        },
      },
      {},
      directory,
      async () => {},
      { query: async () => ({ rows: ids.map((message_id) => ({ message_id })) }) },
      { shouldYield: async () => urgent },
    );
    assert.equal(await queue.next(), null);
    assert.equal(recent, 1);
    assert.equal(extraFetches, 0);
    assert.equal(ingested, 0);
    assert.deepEqual(db.episodes.get("manual:queued").read_ids, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "archived historical threads retain transport identity, mixed tags and fresh metadata",
  {
    skip: process.env.CHECK_DATABASE !== "1",
  },
  async () => {
    const { readFile } = await import("node:fs/promises");
    const { default: pg } = await import("pg");
    const { state } = await import("./runtime.mjs");
    const db = new pg.Client(JSON.parse(await readFile(join(state, "postgres.json"), "utf8")));
    await db.connect();
    const thread = "777777777777777777",
      parentId = "888888888888888888";
    const ids = Array.from({ length: 6 }, (_, i) => String(firstId + BigInt(i)));
    const episode = {
      guildId,
      channelId: thread,
      sourceIds: ids.slice(1, 4),
      contextIds: [ids[0], ids[5]],
    };
    const channel = {
      id: thread,
      guild_id: guildId,
      type: 11,
      parent_id: parentId,
      thread_metadata: { archived: true },
    };
    const parent = { id: parentId, guild_id: guildId, type: 15 };
    const transportReads = [];
    const discord = {
      channel: async (id) => (id === thread ? channel : parent),
      recent: async (id) => {
        assert.equal(id, thread);
        return [];
      },
      get: async (id, messageId) => {
        transportReads.push(messageId);
        assert.equal(id, thread);
        if (messageId === ids[3]) return null;
        return {
          id: messageId,
          channel_id: id,
          author: { id: "333333333333333333", username: "Member" },
          type: 0,
          content: "Fresh edited source",
          timestamp: "2025-01-02T00:00:00Z",
          edited_timestamp: "2025-01-03T00:00:00Z",
        };
      },
    };
    try {
      await db.query(`CREATE TEMP TABLE messages(guild_id text,channel_id text,message_id text,
      created_at timestamptz,deleted_at timestamptz,content text,thread_id text)`);
      for (let i = 0; i < 6; i++)
        await db.query("INSERT INTO messages VALUES($1,$2,$3,$4,NULL,'Archive original',$5)", [
          guildId,
          i === 4 ? channelId : thread,
          ids[i],
          new Date(Date.UTC(2025, 0, 2, 0, i)),
          i === 0 || i === 5 ? null : i === 2 ? parentId : thread,
        ]);
      const selected = await selectAutomaticHistoryWindow(
        db,
        { guildId, channelId: thread, start: "2025-01-01T00:00:00Z", end: "2025-02-01T00:00:00Z" },
        { at: "2025-01-01T00:00:00Z", id: "0" },
        { maxMessages: 24, windowMinutes: 30 },
      );
      assert.deepEqual(
        selected.targets.map((x) => x.message_id),
        [ids[0], ids[1], ids[3], ids[5]],
      );
      const loaded = await currentHistoryEpisode(discord, db, episode);
      assert.deepEqual(
        loaded.rows.map((x) => x.id),
        [ids[1]],
      );
      assert.equal(loaded.rows[0].source.channelId, thread);
      assert.equal(loaded.rows[0].source.content, "Fresh edited source");
      assert.equal(loaded.rows[0].source.editedAt, "2025-01-03T00:00:00Z");
      assert.deepEqual(
        loaded.context.map((x) => x.id),
        [ids[0], ids[5]],
      );
      assert.deepEqual(loaded.excluded, [
        { id: ids[2], reason: "ineligible in archive" },
        { id: ids[3], reason: "deleted" },
      ]);
      assert.ok(!transportReads.includes(ids[2]));
      let urgent = false;
      const metadataReads = [];
      assert.equal(
        await currentHistoryEpisode(
          {
            ...discord,
            channel: async (id) => {
              metadataReads.push(id);
              urgent = true;
              return channel;
            },
          },
          db,
          episode,
          async () => urgent,
        ),
        null,
      );
      assert.deepEqual(metadataReads, [thread]);
      // No live registration/store/sender exists in this path.
      for (const [badChannel, badParent] of [
        [{ ...channel, id: parentId }, parent],
        [{ ...channel, guild_id: parentId }, parent],
        [{ ...channel, type: 12 }, parent],
        [{ ...channel, parent_id: null }, parent],
        [channel, { ...parent, guild_id: parentId }],
        [channel, { ...parent, id: thread }],
        [channel, { ...parent, type: 2 }],
      ])
        await assert.rejects(
          currentHistoryEpisode(
            { ...discord, channel: async (id) => (id === thread ? badChannel : badParent) },
            db,
            episode,
          ),
          /Historical/,
        );
      await assert.rejects(
        currentHistoryEpisode(
          {
            ...discord,
            get: async (_id, id) => ({
              id,
              channel_id: parentId,
              author: { id: guildId },
              type: 0,
              content: "Wrong channel",
              timestamp: "2025-01-02T00:00:00Z",
            }),
          },
          db,
          episode,
        ),
        /Invalid Discord source/,
      );
    } finally {
      await db.end();
    }
  },
);
