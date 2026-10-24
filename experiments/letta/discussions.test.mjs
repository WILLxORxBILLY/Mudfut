import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { state } from "./runtime.mjs";
import { archiveDiscussions } from "./pilot-discussions.mjs";
import { searchGapInvestigator } from "./pilot-search-gaps.mjs";

const guildId = "111111111111111111",
  channelId = "222222222222222222",
  authorId = "333333333333333333",
  botId = "444444444444444444";
const otherChannel = "222222222222222223",
  otherAuthor = "333333333333333334";
const id = (n) => String(555555555555555000n + BigInt(n));
const time = (minute) => new Date(Date.UTC(2026, 5, 1, 12, minute)).toISOString();
const message = (n, extra = {}) => ({
  id: id(n),
  type: extra.message_reference ? 19 : 0,
  channel_id: channelId,
  author: { id: authorId, username: "Member" },
  timestamp: time(n),
  content: "city life opinion",
  ...extra,
});

test("discussion tools validate filters, limits and anchors before querying", async () => {
  let calls = 0;
  const tools = archiveDiscussions(
    {},
    {},
    { guildId },
    {
      query: async () => {
        calls++;
        return { rows: [] };
      },
    },
  );
  for (const input of [
    {},
    { authorIds: [authorId, authorId] },
    { before: "2026-02-30T00:00:00Z" },
    { query: "city", limit: 25 },
    { query: "city", limit: 0 },
    { query: "city", oldestFirst: "false" },
    { query: "city", matchMode: "fuzzy" },
    { authorIds: [authorId], matchMode: "stemmed" },
    { query: "city", after: "2026-02-01T00:00:00Z", before: "2026-01-01T00:00:00Z" },
    { query: "city", unknown: 1 },
    { cursor: "forged" },
  ])
    await assert.rejects(tools.browseArchive(input));
  for (const input of [{}, { anchorId: "bad" }, { anchorId: id(1), channelId }])
    await assert.rejects(tools.readDiscussion(input));
  assert.equal(calls, 0);
});

async function fixture(run) {
  const db = new pg.Client(JSON.parse(await readFile(join(state, "postgres.json"), "utf8")));
  await db.connect();
  try {
    await db.query(`CREATE TEMP TABLE messages (guild_id text,channel_id text,thread_id text,message_id text,
      author_id text,content text,created_at timestamptz,deleted_at timestamptz,PRIMARY KEY(guild_id,message_id))`);
    const originals = new Map(),
      removed = [],
      ingested = [],
      queries = [],
      fetched = [];
    const history = {
      query: async (sql, args) => {
        queries.push(sql);
        return db.query(sql, args);
      },
    };
    const store = {
      remove: async (value) => removed.push(value),
      ingest: async (source) => ingested.push(source),
      db: { query: () => assert.fail("Local cache must not crowd out archive browsing") },
    };
    const discord = {
      recent: async (channel) =>
        [...originals.values()].filter((source) => source.channel_id === channel).slice(-100),
      around: async (channel) =>
        [...originals.values()].filter((source) => source.channel_id === channel).slice(0, 100),
      get: async (channel, value) => {
        fetched.push({ channel, id: value });
        return originals.get(value) ?? null;
      },
    };
    async function insert(n, extra = {}, indexed = {}) {
      const source = message(n, extra);
      originals.set(source.id, source);
      await db.query(
        `INSERT INTO messages(guild_id,channel_id,thread_id,message_id,author_id,content,created_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          indexed.guildId ?? guildId,
          source.channel_id,
          indexed.threadId ?? null,
          source.id,
          source.author.id,
          source.content,
          indexed.createdAt ?? source.timestamp,
          indexed.deletedAt ?? null,
        ],
      );
      return source;
    }
    await run({
      db,
      originals,
      removed,
      ingested,
      queries,
      fetched,
      discord,
      insert,
      tools: archiveDiscussions(
        store,
        discord,
        { guildId: "999999999999999999", botId, historyScope: [] },
        history,
      ),
      factory: (options) =>
        archiveDiscussions(
          store,
          discord,
          { guildId: "999999999999999999", botId },
          history,
          options,
        ),
    });
  } finally {
    await db.end();
  }
}

test(
  "unread chronological originals trigger a query-free investigation without operator gap hints",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () =>
    fixture(async ({ insert, tools }) => {
      await insert(1, { timestamp: time(0), content: "balloon policy initially" });
      await insert(2, {
        timestamp: time(10),
        content: "That only applies when the cost is small.",
      });
      await insert(3, { timestamp: time(20), content: "balloon policy later" });
      await insert(4, { timestamp: time(10), channel_id: otherChannel });
      await insert(5, { timestamp: time(10) }, { deletedAt: time(11) });
      await insert(6, { timestamp: time(10) }, { threadId: id(99) });
      const primary = await tools.browseArchive({ query: "balloon", channelIds: [channelId] });
      assert.deepEqual(
        primary.sources.map((s) => s.id),
        [id(1), id(3)],
      );
      const investigator = searchGapInvestigator({
        now: () => 0,
        deadline: 60_000,
        findGap: (bounds, ids) => tools.findChronologicalGap(bounds, ids),
        inspectGap: (gap) =>
          tools.browseArchive({
            channelIds: [gap.channelId],
            after: gap.after,
            before: new Date(Date.parse(gap.before) + 1).toISOString(),
            limit: 24,
          }),
      });
      const result = await investigator.observe(primary.sources);
      assert.equal(result.status, "inspected");
      assert.equal(result.gap.unreadCountCapped, 1);
      assert.ok(result.inspection.sources.some((source) => source.id === id(2)));
      assert.equal(result.inspection.filters.query, undefined);
      assert.deepEqual(
        primary.sources.map((s) => s.id),
        [id(1), id(3)],
        "Original lexical page stays scoped",
      );
      assert.equal(await tools.findChronologicalGap([result.gap], [id(1), id(2), id(3)]), null);
      await insert(10, { timestamp: time(30) });
      await insert(11, { timestamp: time(30) });
      await insert(12, { timestamp: time(30) });
      const tied = {
        guildId,
        channelId,
        after: time(30),
        before: time(30),
        fromId: id(10),
        toId: id(12),
      };
      assert.equal(
        (await tools.findChronologicalGap([tied], [id(10), id(12)])).unreadCountCapped,
        1,
      );
      assert.equal(
        await tools.findChronologicalGap([{ ...tied, guildId: "111111111111111112" }], []),
        null,
      );
    }),
);

test(
  "real PostgreSQL frozen keyset pages preserve chronology, filter edits, gaps and six-page limits",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () =>
    fixture(async ({ db, originals, removed, ingested, queries, insert, tools, factory }) => {
      for (let n = 1; n <= 150; n++) await insert(n, { timestamp: time(n <= 30 ? 0 : n) });
      await insert(201, { author: { id: otherAuthor, username: "Other" } });
      await insert(202, { channel_id: otherChannel });
      await insert(203, {}, { guildId: "111111111111111112" });
      await insert(204, {}, { threadId: "777777777777777777" });
      await insert(205, {}, { deletedAt: time(0) });
      originals.set(id(2), {
        ...originals.get(id(2)),
        content: "rural life",
        edited_timestamp: time(5),
      });
      originals.delete(id(3));
      const filters = {
        query: "city",
        authorIds: [authorId],
        channelIds: [channelId],
        after: time(0),
        before: time(300),
        limit: 24,
      };
      let page = await tools.browseArchive(filters);
      const firstCursor = page.cursor;
      assert.ok(firstCursor.length <= 128);
      const replayA = await tools.browseArchive({ cursor: firstCursor });
      const replayB = await tools.browseArchive({ cursor: firstCursor });
      assert.deepEqual(
        replayA,
        replayB,
        "Replaying an immutable cursor must preserve selection, metadata and next token",
      );
      assert.equal(page.sources.length, 22);
      assert.equal(
        page.sources[0].guildId,
        guildId,
        "Archive guild identity must not be replaced by the live pilot guild",
      );
      assert.ok(removed.includes(id(3)));
      assert.ok(ingested.some((source) => source.id === id(2) && source.content === "rural life"));
      assert.deepEqual(page.scannedPeriod.from, { at: "2026-06-01T12:00:00.000000Z", id: id(1) });
      assert.equal(page.exhausted, false);
      await assert.rejects(
        tools.browseArchive({ cursor: firstCursor, query: "rural" }),
        /cannot change/,
      );
      await assert.rejects(
        tools.browseArchive({ cursor: firstCursor, limit: 12 }),
        /cannot change/,
      );
      await assert.rejects(factory().browseArchive({ cursor: firstCursor }), /another worker/);
      const tampered =
        firstCursor.slice(0, 10) + (firstCursor[10] === "A" ? "B" : "A") + firstCursor.slice(11);
      await assert.rejects(tools.browseArchive({ cursor: tampered }), /changed/);
      // Newly indexed older rows and SQL deletions cannot shift a frozen chain's boundaries.
      await insert(206, { timestamp: time(0) });
      await db.query("DELETE FROM messages WHERE message_id=$1", [id(25)]);
      const all = [...page.sources];
      while (page.cursor) {
        page = await tools.browseArchive({ cursor: page.cursor });
        all.push(...page.sources);
      }
      assert.equal(page.page, 6);
      assert.equal(page.totalScannedCandidates, 144);
      assert.equal(page.stopReason, "chain-budget");
      assert.equal(page.exhausted, false);
      assert.match(page.remainingGap.reason, /beyond-chain-budget/);
      assert.equal(all.length, 142);
      assert.equal(new Set(all.map((source) => source.id)).size, all.length);
      assert.ok(
        all.some((source) => source.id === id(25)),
        "A frozen index identity still uses its current original",
      );
      assert.ok(!all.some((source) => source.id === id(206)));
      assert.ok(
        !all.some((source) => [id(201), id(202), id(203), id(204), id(205)].includes(source.id)),
      );
      assert.ok(queries.every((sql) => !/BEGIN|COMMIT|ROLLBACK/.test(sql)));
      const empty = await tools.browseArchive({
        query: "nonexistentword",
        channelIds: [channelId],
      });
      assert.deepEqual(empty.sources, []);
      assert.equal(empty.exhausted, true);
      assert.equal(empty.cursor, null);
      const separateGuild = await tools.browseArchive({
        authorIds: [authorId],
        channelIds: [channelId],
        after: time(200),
        before: time(204),
      });
      assert.equal(separateGuild.sources[0].guildId, "111111111111111112");
      let newest = await tools.browseArchive({ ...filters, oldestFirst: false });
      assert.equal(newest.ordering.pages, "newest-first");
      assert.equal(newest.ordering.withinPage, "oldest-first");
      assert.ok(
        newest.sources.some((source) => source.id === id(203)),
        "Descending browsing exposes tail evidence outside the oldest bounded selection",
      );
      assert.equal(newest.remainingGap.direction, "toward-older");
      assert.deepEqual(newest.remainingGap.before, newest.scannedPeriod.through);
      await assert.rejects(
        tools.browseArchive({ ...filters, oldestFirst: true, cursor: newest.cursor }),
        /cannot change/,
      );
      const descendingIds = [];
      while (true) {
        const pageIds = newest.sources.map((source) => source.id);
        assert.deepEqual(
          pageIds,
          [...newest.sources]
            .sort(
              (a, b) =>
                Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
                (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
            )
            .map((source) => source.id),
        );
        descendingIds.push(...pageIds);
        if (!newest.cursor) break;
        newest = await tools.browseArchive({ cursor: newest.cursor });
      }
      assert.equal(newest.page, 6);
      assert.equal(newest.totalScannedCandidates, 144);
      assert.equal(new Set(descendingIds).size, descendingIds.length);
      assert.equal(newest.exhausted, false);
      assert.equal(newest.stopReason, "chain-budget");
      let cursorTime = 1000;
      const expiring = factory({ now: () => cursorTime });
      const expires = await expiring.browseArchive({ authorIds: [authorId], limit: 1 });
      cursorTime += 15 * 60 * 1000;
      await assert.rejects(
        expiring.browseArchive({ cursor: expires.cursor }),
        /expired after 15 minutes/,
      );
      const bounded = factory();
      const oldestToken = await bounded.browseArchive({
        authorIds: [authorId],
        limit: 1,
        before: time(400),
      });
      for (let n = 401; n <= 464; n++)
        await bounded.browseArchive({ authorIds: [authorId], limit: 1, before: time(n) });
      await assert.rejects(bounded.browseArchive({ cursor: oldestToken.cursor }), /evicted/);
    }),
);

test(
  "real discussion context follows fresh reply links, keeps neighbors separate and excludes thread routing",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () =>
    fixture(async ({ originals, removed, fetched, insert, tools, discord }) => {
      await insert(1, { timestamp: time(-45) });
      await insert(2, {
        timestamp: time(-40),
        message_reference: { message_id: id(1), channel_id: channelId },
      });
      await insert(3, { timestamp: time(-2) });
      await insert(4, { timestamp: time(0), message_reference: { message_id: id(2) } });
      await insert(5, { timestamp: time(1), message_reference: { message_id: id(4) } });
      await insert(6, { timestamp: time(2) });
      await insert(7, { timestamp: time(3) }, { threadId: "777777777777777777" });
      await insert(8, { timestamp: time(4), message_reference: { message_id: id(99) } });
      originals.delete(id(6));
      const result = await tools.readDiscussion({ anchorId: id(4) });
      assert.deepEqual(
        result.sources.map((source) => source.id),
        [id(1), id(2), id(3), id(4), id(5), id(8)],
      );
      assert.deepEqual(result.roles[id(4)], ["anchor"]);
      assert.deepEqual(result.roles[id(3)], ["chronological-neighbor"]);
      assert.deepEqual(result.roles[id(5)], ["direct-reply-to-anchor"]);
      assert.deepEqual(result.roles[id(1)], ["reply-ancestor"]);
      assert.deepEqual(result.unavailableReferences, []);
      assert.deepEqual(result.unexpandedReferences, [
        {
          from: id(8),
          to: id(99),
          reason: "not-expanded-within-bounds",
          contentKnown: false,
          referentKnown: false,
          availability: "not-expanded; unavailability-not-established",
        },
      ]);
      assert.ok(
        !fetched.some((source) => source.id === id(99)),
        "Neighbor reply references must not trigger an unbounded fetch expansion",
      );
      assert.match(result.referenceCaveat, /image presence\/content/);
      assert.ok(
        result.replyEdges.some(
          (edge) => edge.from === id(2) && edge.to === id(1) && !edge.crossChannel,
        ),
      );
      assert.equal(result.completeDiscussion, false);
      assert.ok(removed.includes(id(6)));
      assert.ok(result.gaps.some((gap) => gap.id === id(6)));
      assert.ok(
        result.sources.every(
          (source) => source.authorId && source.createdAt && source.url && source.content,
        ),
      );
      const thread = await tools.readDiscussion({ anchorId: id(7) });
      assert.equal(thread.gaps[0].reason, "thread-excluded");
      assert.ok(!removed.includes(id(7)));
      assert.ok(!fetched.some((source) => source.id === id(7)));
      for (let n = 10; n <= 18; n++) await insert(n, { timestamp: time(-n) });
      originals.set(id(4), { ...originals.get(id(4)), message_reference: { message_id: id(3) } });
      const originalGet = discord.get;
      discord.get = async (channel, value) => {
        if (value === id(3)) {
          originals.delete(value);
          return null;
        }
        return originalGet(channel, value);
      };
      const vanishedAncestor = await tools.readDiscussion({ anchorId: id(4) });
      assert.ok(
        !vanishedAncestor.sources.some((source) => source.id === id(3)),
        "An ancestor deleted after neighbor retrieval must not survive as stale context",
      );
      assert.equal(vanishedAncestor.roles[id(3)], undefined);
      assert.ok(
        vanishedAncestor.unavailableReferences.some(
          (edge) =>
            edge.from === id(4) &&
            edge.to === id(3) &&
            !edge.referentKnown &&
            edge.reason === "original-deleted-or-bot",
        ),
      );
      assert.ok(
        vanishedAncestor.gaps.some(
          (gap) => gap.direction === "before" && /neighbor-limit/.test(gap.reason),
        ),
      );
      discord.get = originalGet;
      originals.set(id(4), { ...originals.get(id(4)), message_reference: { message_id: id(99) } });
      const changed = await tools.readDiscussion({ anchorId: id(4) });
      assert.ok(
        changed.gaps.some(
          (gap) => gap.id === id(99) && gap.reason === "not-in-current-archive-index",
        ),
      );
      assert.ok(!changed.sources.some((source) => source.id === id(1) || source.id === id(2)));
      assert.deepEqual(changed.unexpandedReferences, []);
      assert.deepEqual(
        changed.unavailableReferences
          .map(({ from, to, reason }) => ({ from, to, reason }))
          .sort((a, b) => a.from.localeCompare(b.from)),
        [id(4), id(8)].map((from) => ({
          from,
          to: id(99),
          reason: "not-in-current-archive-index",
        })),
      );
      assert.ok(changed.gaps.some((gap) => gap.from === id(4) && gap.to === id(99)));
      assert.equal(
        (await tools.readDiscussion({ anchorId: id(999) })).gaps[0].reason,
        "not-in-current-archive-index",
      );
    }),
);

test(
  "topic browsing separates lexical from stemming candidates and preserves keyword-free qualifications",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () =>
    fixture(async ({ originals, insert, tools }) => {
      for (const [n, content] of [
        [1, "That game was brutal"],
        [2, "The brutality of the war"],
        [3, "Brutalism can be beautiful"],
        [4, "Software architecture needs clean interfaces"],
        [5, "The architecture of this museum is beautiful"],
        [6, "I still value their lives and care about people"],
        [7, "Brutalism was the old message"],
      ])
        await insert(n, { content });
      originals.set(id(7), {
        ...originals.get(id(7)),
        content: "An unrelated edit",
        edited_timestamp: time(8),
      });
      const filters = { query: "brutalism OR architecture", channelIds: [channelId] };
      const lexical = await tools.browseArchive(filters);
      assert.deepEqual(
        lexical.sources.map(({ id }) => id),
        [id(3), id(4), id(5)],
      );
      assert.equal(lexical.matchMode, "lexical");
      assert.ok(Object.values(lexical.matchEvidence).every((match) => match.lexicalMatch));
      assert.match(lexical.relevance, /not assessed topic relevance/);
      assert.match(lexical.coverage, /keyword-missing qualifications/);
      // Literal metaphor matches remain candidates, never silently classified as on-topic.
      assert.ok(lexical.matchEvidence[id(4)].lexicalMatch);
      const broad = await tools.browseArchive({ ...filters, matchMode: "stemmed", limit: 2 });
      assert.deepEqual(
        broad.sources.map(({ id }) => id),
        [id(1), id(2)],
      );
      assert.deepEqual(broad.matchEvidence[id(1)], { lexicalMatch: false, stemmedMatch: true });
      await assert.rejects(
        tools.browseArchive({ cursor: broad.cursor, ...filters }),
        /cannot change/,
      );
      const next = await tools.browseArchive({ cursor: broad.cursor });
      assert.equal(next.matchMode, "stemmed");
      assert.deepEqual(
        next.sources.map(({ id }) => id),
        [id(3), id(4)],
      );
      const discussion = await tools.readDiscussion({ anchorId: id(3) });
      const interval = await tools.browseArchive({
        ...discussion.qualificationSearch.filters,
        authorIds: [authorId],
      });
      assert.ok(interval.sources.some((source) => source.id === id(6)));
      assert.equal(interval.matchEvidence, undefined);
      assert.match(discussion.qualificationSearch.guidance, /intervening periods/);
    }),
);
