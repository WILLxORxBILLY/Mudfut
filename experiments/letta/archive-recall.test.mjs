import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { state } from "./runtime.mjs";
import { archiveInput, archiveTool } from "./pilot-discord.mjs";

const guildId = "111111111111111111";
const channelId = "222222222222222222";
const authorId = "333333333333333333";
const botId = "444444444444444444";
const id = (n) => String(555555555555555500n + BigInt(n));
const source = (n) => ({ id: id(n), guildId, channelId, authorId });
const message = (n, content = "Current opinion: city life is good") => ({
  id: id(n),
  channel_id: channelId,
  author: { id: authorId, username: "Member" },
  content,
  timestamp: "2026-06-10T12:00:00.000Z",
  type: 0,
});

function harness(local, archived, originals = new Map()) {
  const queries = [];
  const removed = [];
  const ingested = [];
  const fetched = [];
  const store = {
    db: {
      query: async (sql, values) => {
        queries.push({ engine: "local", sql, values });
        if (sql.includes("jsonb_to_recordset"))
          return {
            rows: JSON.parse(values[0]).map(({ id }) => ({
              id,
              lexicalMatch: true,
              stemmedMatch: true,
            })),
          };
        return { rows: local.map((source) => ({ source })) };
      },
    },
    optedOut: async () => assert.fail("Retired member privacy settings must not filter recall"),
    remove: async (value) => removed.push(value),
    ingest: async (...values) => ingested.push(values),
  };
  const history = {
    query: async (sql, values) => {
      queries.push({ engine: "archive", sql, values });
      return { rows: sql.startsWith("SELECT") ? archived : [] };
    },
  };
  const discord = {
    get: async (channel, value) => {
      fetched.push([channel, value]);
      return originals.has(value)
        ? originals.get(value)
        : message(Number(BigInt(value) - BigInt(id(0))));
    },
  };
  return {
    search: archiveTool(store, discord, { historyScope: [], botId }, history),
    queries,
    removed,
    ingested,
    fetched,
  };
}

test("archive search validates bounded person/topic/date filters before touching a store", () => {
  for (const input of [
    { query: '"city life" OR suburbs', authorIds: [authorId], oldestFirst: true },
    { authorIds: [authorId], after: "2026-01-01T00:00:00Z", before: "2026-07-01T00:00:00Z" },
    { channelIds: [channelId] },
    { messageId: id(1) },
    { query: "word", matchMode: "stemmed" },
  ])
    assert.doesNotThrow(() => archiveInput(input));
  for (const input of [
    {},
    { oldestFirst: true },
    { authorIds: [authorId], matchMode: "stemmed" },
    { query: "word", matchMode: "unknown" },
    { query: "" },
    { query: "x", authorIds: [] },
    { authorIds: [authorId, authorId] },
    { authorIds: Array(9).fill(authorId) },
    { authorIds: ["1 OR TRUE"] },
    { query: "x", channelIds: ["*"] },
    { messageId: id(1), authorIds: [authorId] },
    { query: "x", after: "2026-02-30T00:00:00Z" },
    { query: "x", after: "2026-01-01" },
    { query: "x", after: "2026-07-01T00:00:00Z", before: "2026-01-01T00:00:00Z" },
    { query: "x", oldestFirst: "yes" },
    { query: "x", unexpected: true },
  ])
    assert.throws(() => archiveInput(input));
});

test("archive evidence survives eight local hits with deduplication and fresh mutation checks", async () => {
  const local = Array.from({ length: 8 }, (_, n) => source(n + 1));
  const archived = [source(1), ...Array.from({ length: 7 }, (_, n) => source(n + 20))];
  const originals = new Map([
    [id(20), null],
    [id(2), { ...message(2), author: { id: botId, bot: true } }],
    [id(3), { ...message(3), author: { id: botId } }],
    [id(21), message(21, "Correction: I now prefer city life")],
  ]);
  const h = harness(local, archived, originals);
  const result = await h.search({ query: '"city life" OR suburbs' });
  assert.equal(result.sources.length, 8);
  assert.equal(new Set(result.sources.map((s) => s.id)).size, 8);
  assert.ok(
    result.sources.some((s) => BigInt(s.id) >= BigInt(id(20))),
    "Archive must not be crowded out by eight local hits",
  );
  assert.equal(
    result.sources.find((s) => s.id === id(21)).content,
    "Correction: I now prefer city life",
  );
  assert.deepEqual(h.removed, [id(20)]);
  assert.ok(result.sources.every((s) => s.authorId !== botId));
  assert.equal(h.fetched.filter(([, value]) => value === id(1)).length, 1);
  assert.ok(h.fetched.length <= 16);
  assert.ok(
    h.ingested.every(([, addressed, learnable]) => addressed === false && learnable === false),
  );
  assert.equal(h.queries.filter((query) => query.engine === "archive").at(-1).sql, "COMMIT");
});

test("archive search stops fresh reads at eight before checking current token matches", async () => {
  const h = harness(
    Array.from({ length: 8 }, (_, n) => source(n + 1)),
    Array.from({ length: 8 }, (_, n) => source(n + 20)),
  );
  const result = await h.search({ query: "city" });
  assert.equal(result.sources.length, 8);
  assert.equal(h.fetched.length, 8);
});

test("person/topic filters reach both ranked queries while legacy channel and opt-out gates are retired", async () => {
  const h = harness([source(1)], [source(20)]);
  const input = {
    query: '"city life" OR suburbs',
    authorIds: [authorId],
    channelIds: [channelId],
    after: "2026-01-01T00:00:00Z",
    before: "2026-07-01T00:00:00Z",
    oldestFirst: true,
  };
  const result = await h.search(input);
  assert.equal(
    result.sources.length,
    2,
    "Empty legacy historyScope must not disable archive recall",
  );
  const selects = h.queries.filter(
    (q) => q.sql.startsWith("SELECT") && !q.sql.includes("jsonb_to_recordset"),
  );
  assert.equal(selects.length, 2);
  for (const { sql, values } of selects) {
    assert.deepEqual(values, [
      null,
      input.query,
      input.authorIds,
      input.channelIds,
      input.after,
      input.before,
      "simple",
    ]);
    assert.match(sql, /ts_rank_cd/);
    assert.match(sql, /ANY\(\$3\)/);
    assert.match(sql, /ANY\(\$4\)/);
    assert.match(sql, /ASC/);
    assert.doesNotMatch(sql, /opted_out|members|jsonb_to_recordset/);
    assert.ok(!sql.includes(input.query), "User search text must stay in bound parameters");
  }
});

test("fresh sources that fail selected person filters are ingested but omitted", async () => {
  const current = { ...message(20), author: { id: "666666666666666666", username: "Different" } };
  const h = harness([], [source(20)], new Map([[id(20), current]]));
  const result = await h.search({ authorIds: [authorId] });
  assert.equal(result.sources.length, 0);
  assert.equal(h.ingested[0][0].authorId, current.author.id);
});

test(
  "PostgreSQL filters both pools by person/topic/date and ranks relevance before recency",
  {
    skip: process.env.CHECK_DATABASE !== "1",
  },
  async () => {
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const db = new pg.Client(credentials);
    await db.connect();
    try {
      // Session-local tables cannot alter the fixture's other test connections.
      await db.query(`CREATE TEMP TABLE pilot_sources (id text,source jsonb,deleted boolean DEFAULT false);
      CREATE TEMP TABLE messages (message_id text,guild_id text,channel_id text,
        author_id text,content text,created_at timestamptz,deleted_at timestamptz)`);
      const originals = new Map();
      for (const [n, author, content, time] of [
        [1, authorId, "city city city life", "2026-03-01T00:00:00Z"],
        [2, authorId, "city", "2026-06-01T00:00:00Z"],
        [3, botId, "city city city", "2026-06-01T00:00:00Z"],
        [4, authorId, "city", "2025-01-01T00:00:00Z"],
        [20, authorId, "city city city life", "2026-03-01T00:00:00Z"],
        [21, authorId, "city", "2026-06-01T00:00:00Z"],
      ]) {
        const current = {
          ...message(n, content),
          timestamp: time,
          author: { id: author, username: "Member" },
        };
        originals.set(id(n), current);
        if (n < 20)
          await db.query("INSERT INTO pilot_sources(id,source) VALUES($1,$2)", [
            id(n),
            {
              ...source(n),
              authorId: author,
              content,
              createdAt: time,
            },
          ]);
        else
          await db.query(
            "INSERT INTO messages(message_id,guild_id,channel_id,author_id,content,created_at) VALUES($1,$2,$3,$4,$5,$6)",
            [id(n), guildId, channelId, author, content, time],
          );
      }
      const store = { db, remove: async () => {}, ingest: async () => {} };
      const search = archiveTool(
        store,
        { get: async (_, value) => originals.get(value) },
        { historyScope: [], botId },
        db,
      );
      const result = await search({
        query: "city",
        authorIds: [authorId],
        channelIds: [channelId],
        after: "2026-01-01T00:00:00Z",
        before: "2027-01-01T00:00:00Z",
      });
      assert.deepEqual(
        result.sources.map((s) => s.id),
        [id(20), id(1), id(21), id(2)],
      );
      for (const [n, content] of [
        [30, "brutalism can be beautiful"],
        [31, "the brutal war"],
        [32, "brutalism before an edit"],
      ]) {
        originals.set(id(n), {
          ...message(n, n === 32 ? "unrelated after edit" : content),
          edited_timestamp: n === 32 ? "2026-06-11T00:00:00Z" : undefined,
        });
        await db.query(
          "INSERT INTO messages(message_id,guild_id,channel_id,author_id,content,created_at) VALUES($1,$2,$3,$4,$5,$6)",
          [id(n), guildId, channelId, authorId, content, "2026-06-10T12:00:00Z"],
        );
      }
      const exactTopic = await search({ query: "brutalism" });
      assert.deepEqual(
        exactTopic.sources.map(({ id }) => id),
        [id(30)],
      );
      const broadTopic = await search({ query: "brutalism", matchMode: "stemmed" });
      assert.deepEqual(new Set(broadTopic.sources.map(({ id }) => id)), new Set([id(30), id(31)]));
      assert.deepEqual(broadTopic.matchEvidence[id(31)], {
        lexicalMatch: false,
        stemmedMatch: true,
      });
      assert.match(broadTopic.coverage, /not topic completeness/);
    } finally {
      await db.end();
    }
  },
);
