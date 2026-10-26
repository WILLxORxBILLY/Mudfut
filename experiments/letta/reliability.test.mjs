import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { state } from "./runtime.mjs";
import {
  archiveReader,
  ArchiveUnavailable,
  optionalArchive,
  archiveToolBoundary,
} from "./pilot-archive-reader.mjs";
import { toolLifecycle } from "./pilot-tool-lifecycle.mjs";
import { channelPollStatus, channelStatus } from "./pilot-channel-status.mjs";
import { pollLiveChannels } from "./pilot-live-channels.mjs";
import { historyQueue } from "./pilot-history.mjs";
import { pilotStore, sourceRecord, emptyMemory, deliver } from "./pilot-store.mjs";
import { memoryStore } from "./memory.mjs";

const guildId = "111111111111111111",
  channelId = "222222222222222222",
  forumId = "222222222222222223",
  threadId = "222222222222222224";
const config = { guildId, channelId, replyChannelIds: [channelId, forumId] };
const timestamp = "2026-10-24T12:00:00.000Z",
  now = Date.parse(timestamp);

test("an in-flight archive tool failure remains an explicit unavailable result at the model boundary", async () => {
  const tools = toolLifecycle();
  let reject;
  const read = new Promise((_, fail) => {
    reject = fail;
  });
  let recorded = 0;
  const task = tools.run(() =>
    archiveToolBoundary(
      () => read,
      async () => {
        recorded++;
      },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const drained = tools.finish();
  reject(new ArchiveUnavailable({ code: "57014" }));
  const result = await task;
  await drained;
  assert.equal(result.isError, true);
  assert.equal(recorded, 1);
  assert.equal(JSON.parse(result.content[0].text).error, "ARCHIVE_UNAVAILABLE");
  assert.match(result.content[0].text, /did not complete/);
  const native = { code: "57014" };
  await assert.rejects(
    archiveToolBoundary(async () => {
      throw native;
    }),
    (e) => e === native,
  );
});

test("archive connect and idle failures pause only the separate reader without leaking diagnostics", async () => {
  for (const at of ["connect", "query", "idle"]) {
    const original = Object.assign(new Error("postgres://user:private@host/database"), {
      code: "57014",
    });
    let closed = 0,
      queries = 0;
    const client = Object.assign(new EventEmitter(), {
      connect: async () => {
        if (at === "connect") throw original;
      },
      query: async () => {
        queries++;
        throw original;
      },
      end: async () => {
        closed++;
      },
    });
    const reports = [];
    const reader = archiveReader(client, { report: async (s) => reports.push(s) });
    if (at === "connect") await assert.rejects(reader.connect(), ArchiveUnavailable);
    else {
      await reader.connect();
      if (at === "idle") client.emit("error", original);
      await assert.rejects(reader.query("SELECT 1"), ArchiveUnavailable);
    }
    const before = queries;
    await assert.rejects(reader.query("SELECT 2"), ArchiveUnavailable);
    assert.equal(queries, before, "a paused reader must not retry automatically");
    await reader.query("ROLLBACK");
    await reader.end();
    assert.equal(closed, 1);
    assert.equal(reader.paused, true);
    assert.equal(reports.at(-1).state, "paused");
    assert.equal(reports.at(-1).code, "57014");
    assert(!JSON.stringify(reports).includes("private"));
  }
  const native = Object.assign(new Error("native statement timeout"), { code: "57014" });
  await assert.rejects(
    optionalArchive(async () => {
      throw native;
    }),
    (error) => error === native,
    "the same SQLSTATE from the native writer remains fatal",
  );
});

test("archive status persistence errors remain visible instead of silently continuing", async () => {
  const storage = new Error("status storage failed");
  const client = Object.assign(new EventEmitter(), {
    connect: async () => {},
    query: async () => {
      throw new Error("read failed");
    },
    end: async () => {},
  });
  const reader = archiveReader(client, {
    report: async (s) => {
      if (s.state === "paused") throw storage;
    },
  });
  await reader.connect();
  await assert.rejects(
    optionalArchive(() => reader.query("SELECT 1")),
    (error) => error === storage,
  );
  await reader.end();
  const idleClient = Object.assign(new EventEmitter(), {
    connect: async () => {},
    end: async () => {},
  });
  const idleReader = archiveReader(idleClient, {
    report: async (s) => {
      if (s.state === "paused") throw storage;
    },
  });
  await idleReader.connect();
  idleClient.emit("error", new Error("connection closed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(
    () => idleReader.paused,
    (error) => error === storage,
  );
  await idleReader.end();
});

test("endpoint read denials retain failed diagnostics while healthy channels continue", async () => {
  const saved = [];
  const recorder = channelPollStatus(
    config,
    [
      { id: channelId, name: "text", type: 0 },
      { id: forumId, name: "forum", type: 15 },
    ],
    { save: async (s) => saved.push(s), now: () => now },
  );
  const cursors = { [channelId]: "555555555555555500" };
  const healthy = { id: "555555555555555501", channel_id: channelId };
  const denied = Object.assign(new Error("Forbidden"), { status: 403, code: 50013 });
  const store = { meta: async () => ({ cursors: { ...cursors } }) };
  const poll = (discord, observe = async () => {}) =>
    pollLiveChannels(store, discord, config, [channelId, threadId], observe);
  const outcome = await poll(
    {
      after: async () => [healthy],
      recent: async () => {
        throw denied;
      },
    },
    (results) =>
      recorder.polled(
        { channelIds: [channelId, threadId], threads: [{ id: threadId, parent_id: forumId }] },
        results,
      ),
  );
  assert.deepEqual(outcome, { messages: [healthy], emptyChannelIds: [] });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].polls[channelId].ok, true);
  assert.equal(saved[0].polls[threadId].ok, false);
  assert.equal(saved[0].polls[threadId].status, 403);
  assert.equal(cursors[threadId], undefined, "a denied initial read cannot activate live replies");

  for (const [status, code] of [
    [403, 50001],
    [404, 10003],
  ]) {
    const blocked = await poll({
      after: async () => [healthy],
      recent: async () => {
        throw { status, code };
      },
    });
    assert.deepEqual(blocked, outcome);
  }
  // A checkpoint's recovered read must not change the main cycle's captured outcome.
  const recoveredEmpty = await poll({ after: async () => [], recent: async () => [] });
  assert.deepEqual(recoveredEmpty.emptyChannelIds, [threadId]);
  assert.deepEqual(outcome.emptyChannelIds, []);
  const recovered = { ...healthy, id: "555555555555555502", channel_id: threadId };
  const recoveredMessages = await poll({ after: async () => [], recent: async () => [recovered] });
  assert.deepEqual(recoveredMessages, { messages: [recovered], emptyChannelIds: [] });

  for (const failure of [
    { status: 401, code: 50001 },
    { status: 403 },
    { status: 403, code: 50035 },
    { status: 404, code: 10008 },
    { status: 500, code: 50001 },
    new Error("offline"),
  ])
    await assert.rejects(
      poll({
        after: async () => [],
        recent: async () => {
          throw failure;
        },
      }),
      (error) => error === failure,
    );
  await assert.rejects(
    poll({ after: async () => [recovered], recent: async () => [] }),
    /different channel/,
  );
  await assert.rejects(poll({ after: async () => [], recent: async () => ({}) }), TypeError);
  await assert.rejects(
    poll({ after: async () => [], recent: async () => [] }, async () => {
      throw denied;
    }),
    (error) => error === denied,
  );
  await assert.rejects(
    pollLiveChannels(
      {
        meta: async () => {
          throw denied;
        },
      },
      {
        after: async () => assert.fail("storage failure must precede any read"),
      },
      config,
    ),
    (error) => error === denied,
  );
  assert.equal(cursors[channelId], "555555555555555500");
});

test("overlapping poll snapshots persist in order without regressing channel evidence", async () => {
  let release;
  const wait = new Promise((resolve) => {
      release = resolve;
    }),
    saved = [];
  const recorder = channelPollStatus(
    config,
    [
      { id: channelId, type: 0 },
      { id: forumId, type: 15 },
    ],
    {
      now: () => now,
      save: async (s) => {
        if (!saved.length) await wait;
        saved.push(s);
      },
    },
  );
  const discovered = { at: timestamp, channelIds: [channelId], threads: [] };
  const first = recorder.polled(discovered, [{ channelId, ok: true, at: timestamp }]);
  const older = recorder.polled({ ...discovered, at: "2026-10-24T11:59:00.000Z" }, [
    { channelId, ok: false, at: "2026-10-24T11:59:00.000Z", error: { status: 403 } },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 0);
  release();
  await Promise.all([first, older]);
  assert.equal(saved.length, 2);
  assert.equal(saved.at(-1).polls[channelId].ok, true);
  assert.equal(saved.at(-1).polls[channelId].lastSuccessAt, timestamp);
  assert.equal(saved.at(-1).discovery.at, timestamp);
});

test("channel report distinguishes read evidence, pending targets, held delivery, and unknown status", async () => {
  const statements = [];
  const db = {
    query: async (sql) => {
      statements.push(sql);
      if (sql.startsWith("SELECT to_regclass"))
        return { rows: [{ meta: "pilot_meta", sources: "pilot_sources", outbox: "pilot_outbox" }] };
      if (sql.startsWith("SELECT scope"))
        return { rows: [{ scope: config, cursors: { [channelId]: "555555555555555500" } }] };
      if (sql.startsWith("SELECT channel_id"))
        return { rows: [{ channel_id: threadId, parent_id: forumId }] };
      if (sql.includes("count(*) FILTER"))
        return {
          rows: [
            { channel_id: channelId, pending: 2 },
            { channel_id: threadId, held: 1 },
          ],
        };
      if (sql.includes("DISTINCT ON"))
        return {
          rows: [
            {
              channel_id: channelId,
              source_id: "555555555555555500",
              discord_id: "555555555555555599",
              attempted_at: timestamp,
            },
          ],
        };
      return { rows: [] };
    },
  };
  const runtime = {
    health: { pid: 123, at: timestamp },
    recovery: { running: true, held: false, workerPid: 123 },
    now,
  };
  const poll = {
    schemaVersion: 1,
    guildId,
    routes: [
      { id: channelId, type: 0 },
      { id: forumId, type: 15 },
    ],
    activeChannelIds: [channelId, threadId],
    threads: { [threadId]: forumId },
    polls: {
      [channelId]: { ok: true, lastSuccessAt: timestamp },
      [threadId]: { ok: false, lastSuccessAt: "2026-10-24T11:00:00Z", lastAttemptAt: timestamp },
    },
    discovery: { ok: true, at: timestamp },
  };
  const result = await channelStatus(db, config, {
    ...runtime,
    poll,
    archive: { state: "paused" },
  });
  assert.equal(result.runtime.state, "recent-progress");
  assert.equal(result.archive.state, "paused");
  assert.equal(result.channels[0].pendingAddressed, 2);
  assert.deepEqual(result.channels[0].blockers, []);
  assert.equal(result.channels[0].endpoints[0].readState, "recent-success");
  assert.match(result.channels[0].endpoints[0].lastDeliveredReply.url, /555555555555555599$/);
  assert(result.channels[1].blockers.includes("ambiguous-or-held-delivery"));
  assert(result.channels[1].blockers.includes("last-poll-failed"));
  assert.equal(statements[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(statements.at(-1), "ROLLBACK");
  assert(!statements.some((sql) => /^(INSERT|UPDATE|DELETE|CREATE|ALTER)/.test(sql)));
  const unknown = await channelStatus(db, config, {
    ...runtime,
    recovery: { held: true, running: false },
  });
  assert.equal(unknown.channels[0].endpoints[0].readState, "unobserved");
  assert(unknown.channels[0].blockers.includes("worker-held"));
  const stale = await channelStatus(db, config, { ...runtime, poll, now: now + 240001 });
  assert.equal(stale.channels[0].endpoints[0].readState, "stale-success");
});

test(
  "real archive selection timeout leaves history unread while the sole native writer delivers a live reply",
  { skip: process.env.CHECK_DATABASE !== "1", timeout: 30000 },
  async () => {
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    assert.equal(credentials.user, "mudfut_fixture");
    const admin = new pg.Client(credentials);
    await admin.connect();
    const name = "mudfut_reliability_" + randomUUID().replaceAll("-", "");
    const directory = await mkdtemp(join(tmpdir(), "mudfut-reliability-"));
    execFileSync("git", ["init", "--quiet", directory]);
    let db, history;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      db = new pg.Client({ ...credentials, database: name });
      await db.connect();
      await db.query(`CREATE VIEW messages AS SELECT '${guildId}'::text guild_id,'${channelId}'::text channel_id,
      '555555555555555501'::text message_id,'2026-01-02T00:00:00Z'::timestamptz created_at,
      NULL::timestamptz deleted_at,NULL::text thread_id,'Fictional archive source'::text content FROM pg_sleep(0.2)`);
      const store = await pilotStore(db, { guildId, channelId });
      const reports = [];
      history = archiveReader(
        new pg.Client({
          ...credentials,
          database: name,
          options: "-c default_transaction_read_only=on",
          statement_timeout: 30,
        }),
        { report: async (s) => reports.push(s) },
      );
      await history.connect();
      await writeFile(
        join(directory, "history-automation.json"),
        JSON.stringify({
          id: "timeout-proof",
          enabled: true,
          channels: [
            { guildId, channelId, start: "2026-01-01T00:00:00Z", end: "2026-01-03T00:00:00Z" },
          ],
          cooldownSeconds: 0,
        }),
      );
      const queue = historyQueue(store, {}, config, directory, async () => {}, history);
      assert.deepEqual(await optionalArchive(() => queue.next()), {
        disposition: "deferred",
        reason: "archive-paused",
      });
      assert.equal(history.paused, true);
      assert.equal(reports.at(-1).code, "57014");
      const cursor = (await db.query("SELECT cursor_at,cursor_id FROM pilot_history_automation"))
        .rows[0];
      assert.equal(cursor.cursor_id, "0");
      assert.equal(cursor.cursor_at.toISOString(), "2026-01-01T00:00:00.000Z");
      assert.equal(
        (await db.query("SELECT count(*)::int n FROM pilot_history_episodes")).rows[0].n,
        0,
      );
      const source = sourceRecord(
        {
          id: "555555555555555502",
          channel_id: channelId,
          author: { id: "333333333333333333", username: "Fictional member" },
          type: 0,
          content: "Please reply",
          timestamp,
        },
        guildId,
        channelId,
      );
      await store.ingest(source, true);
      const batch = await store.next();
      assert.equal(batch.replyTo, source.id);
      const memory = memoryStore(directory);
      await store.prepare(
        (await store.meta()).epoch,
        batch,
        { content: emptyMemory, expectedRevision: (await memory.read()).revision },
        "A live reply",
      );
      await store.finish(memory);
      let sends = 0;
      await deliver(
        store,
        {
          send: async (id, body) => {
            assert.equal(id, channelId);
            assert.equal(body.message_reference.message_id, source.id);
            sends++;
            return { id: "555555555555555599" };
          },
        },
        "444444444444444444",
        channelId,
        async () => {},
      );
      assert.equal(sends, 1);
      assert.equal((await db.query("SELECT status FROM pilot_outbox")).rows[0].status, "sent");
      const report = await channelStatus(
        db,
        { guildId, channelId },
        {
          now,
          health: { pid: 123, at: timestamp },
          recovery: { running: true, workerPid: 123 },
          archive: history.status(),
          poll: {
            schemaVersion: 1,
            guildId,
            routes: [{ id: channelId, type: 0 }],
            polls: { [channelId]: { ok: true, lastSuccessAt: timestamp } },
            threads: {},
            activeChannelIds: [channelId],
          },
        },
      );
      assert.equal(report.archive.state, "paused");
      assert.equal(report.scopeMatches, true);
      assert.equal(report.channels[0].pendingAddressed, 0);
      assert.equal(report.channels[0].endpoints[0].lastDeliveredReply.sourceId, source.id);
      assert.deepEqual(report.channels[0].blockers, []);
      await db.query("SET statement_timeout=30");
      await assert.rejects(
        optionalArchive(() => db.query("SELECT pg_sleep(0.2)")),
        (error) => error.code === "57014" && !(error instanceof ArchiveUnavailable),
      );
      await db.query("SET statement_timeout=10000");
    } finally {
      await history?.end();
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
