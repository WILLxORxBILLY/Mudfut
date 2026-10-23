import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { state } from "./runtime.mjs";
import { pilotStore, sourceRecord, digest } from "./pilot-store.mjs";
import { historyQueue } from "./pilot-history.mjs";
import { historicalFailureClass, historyFailures } from "./pilot-history-failures.mjs";

const guildId = "111111111111111111",
  channelId = "222222222222222222";
const id = (n) => String(555555555555555500n + BigInt(n));
const message = (n) => ({
  id: id(n),
  channel_id: channelId,
  author: { id: "333333333333333333", username: "Fixture" },
  type: 0,
  content: "An archived conversation",
  timestamp: "2026-02-01T00:00:00Z",
});
const manifest = (key, n) => ({
  key,
  label: "Isolated retry fixture",
  guildId,
  channelId,
  sourceIds: [id(n)],
  contextIds: [],
});

test("historical failures distinguish recoverable episode errors, intentional yields and infrastructure/auth failures", () => {
  assert.equal(
    historicalFailureClass(new Error("Model omitted explicit observation decisions")),
    "episode",
  );
  assert.equal(historicalFailureClass(new SyntaxError("Unexpected JSON")), "episode");
  assert.equal(historicalFailureClass({ code: "HISTORY_PREEMPTED" }), "preempted");
  assert.equal(
    historicalFailureClass(new Error("Native turn cancelled"), { stopping: true }),
    "shutdown",
  );
  for (const error of [
    { status: 401 },
    { status: 403 },
    { status: 429 },
    { status: 503 },
    { code: "ECONNRESET" },
    { code: "08006" },
    { code: "22P02" },
    { code: "ENOSPC" },
    { cause: { code: "ECONNREFUSED" } },
    new Error("PostgreSQL memory checksum mismatch"),
    new Error("invalid_grant: refresh token revoked"),
  ])
    assert.equal(historicalFailureClass(error), "infrastructure");
  assert.equal(
    historicalFailureClass({ status: 403, code: 50001 }, { phase: "history_load" }),
    "source_access",
  );
  assert.equal(
    historicalFailureClass({ status: 403, code: 50013 }, { phase: "history_validation" }),
    "source_access",
  );
  assert.equal(
    historicalFailureClass({ status: 403, code: 50001 }, { phase: "model" }),
    "source_access",
  );
});

test("operator deferral preserves queued history without inventing another processing failure", async () => {
  let status = "retry";
  const statements = [];
  const store = {
    transaction: async (action) => action(),
    meta: async () => ({ epoch: 7 }),
    db: {
      query: async (sql, args = []) => {
        statements.push({ sql, args });
        if (sql.startsWith("SELECT * FROM pilot_history_episodes"))
          return { rows: [{ status, failure_count: 1 }] };
        if (sql.includes("SELECT 1 FROM pilot_work")) return { rowCount: 0 };
        if (sql.includes("max(attempt_no)")) return { rows: [{ n: "2" }] };
        if (sql.startsWith("UPDATE pilot_history_episodes")) status = "deferred";
        return { rowCount: 1, rows: [] };
      },
    },
  };
  const events = [];
  const deferred = await historyFailures(store, async (event) => events.push(event)).defer(
    "auto-fixture:window",
    "Hold automatic archive learning outside this repair scope",
  );
  assert.equal(deferred.status, "deferred");
  assert.equal(status, "deferred");
  const audit = statements.find(({ sql }) => sql.startsWith("INSERT INTO pilot_history_failures"));
  assert.match(audit.sql, /'operator_scope'/);
  assert.equal(
    JSON.parse(audit.args[4]).reason,
    "Hold automatic archive learning outside this repair scope",
  );
  assert.equal(events[0].type, "history_episode_operator_deferred");
});

test("operator resumption audits a zero-read scope hold without resetting prior evidence", async () => {
  let status = "deferred",
    failureCount = 0,
    workExists = true;
  const readIds = [],
    contextIds = [id(9)],
    failures = [
      {
        attempt_no: 1,
        phase: "operator_hold",
        classification: "operator_scope",
        outcome: "deferred",
      },
    ],
    statements = [];
  const store = {
    transaction: async (action) => action(),
    meta: async () => ({ epoch: 8 }),
    db: {
      query: async (sql, args = []) => {
        statements.push({ sql, args });
        if (sql.startsWith("SELECT * FROM pilot_history_episodes"))
          return {
            rows: [
              {
                status,
                work_id: null,
                read_ids: readIds,
                context_ids: contextIds,
                failure_count: failureCount,
              },
            ],
          };
        if (sql.startsWith("SELECT attempt_no,phase,classification,outcome"))
          return { rows: [failures.at(-1)] };
        if (sql.startsWith("SELECT 1 FROM pilot_work")) return { rowCount: workExists ? 1 : 0 };
        if (sql.includes("max(attempt_no)")) return { rows: [{ n: String(failures.length + 1) }] };
        if (sql.startsWith("INSERT INTO pilot_history_failures")) {
          failures.push({
            attempt_no: args[1],
            phase: "operator_resume",
            classification: "operator_scope",
            outcome: "resumed",
            detail: JSON.parse(args[4]),
          });
        }
        if (sql.startsWith("UPDATE pilot_history_episodes")) status = "queued";
        return { rowCount: 1, rows: [] };
      },
    },
  };
  const events = [];
  const resume = historyFailures(store, async (event) => events.push(event)).resume;
  await assert.rejects(
    resume("scope-held:window", "Founder resumed the retained selection"),
    /work already exists/,
  );
  assert.equal(status, "deferred");
  assert.equal(failures.length, 1);
  workExists = false;
  const resumed = await resume("scope-held:window", "Founder resumed the retained selection");
  assert.deepEqual(resumed, {
    episodeId: "scope-held:window",
    attemptNo: 2,
    status: "queued",
    reason: "Founder resumed the retained selection",
  });
  assert.equal(status, "queued");
  assert.equal(failureCount, 0);
  assert.deepEqual(readIds, []);
  assert.deepEqual(contextIds, [id(9)]);
  assert.equal(failures.length, 2);
  assert.deepEqual(failures[0], {
    attempt_no: 1,
    phase: "operator_hold",
    classification: "operator_scope",
    outcome: "deferred",
  });
  assert.deepEqual(failures[1].detail, {
    reason: "Founder resumed the retained selection",
    resumedAfterAttempt: 1,
  });
  assert.match(
    statements.find(({ sql }) => sql.startsWith("UPDATE pilot_history_episodes")).sql,
    /SET status='queued',next_attempt_at=NULL/,
  );
  assert.equal(events[0].type, "history_episode_operator_resumed");
});

async function isolated(action) {
  const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
  const admin = new pg.Client(credentials);
  await admin.connect();
  const name = "mudfut_history_retry_" + randomUUID().replaceAll("-", "");
  const directory = await mkdtemp(join(tmpdir(), "mudfut-history-retry-"));
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    db = new pg.Client({ ...credentials, database: name });
    await db.connect();
    const store = await pilotStore(db, { guildId, channelId });
    await action({ db, store, directory });
  } finally {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}

async function add(db, key, n, overrides = {}) {
  await db.query(
    "INSERT INTO pilot_history_passes(id,manifest) VALUES('retry-fixture',$1) ON CONFLICT DO NOTHING",
    [{ id: "retry-fixture", episodes: [manifest(key, n)] }],
  );
  const episodeId = "retry-fixture:" + key;
  await db.query(
    "INSERT INTO pilot_history_episodes(id,pass_id,manifest) VALUES($1,'retry-fixture',$2)",
    [episodeId, { ...manifest(key, n), ...overrides }],
  );
  return episodeId;
}
const transport = {
  channel: async (id) => ({ id, guild_id: guildId, type: 0 }),
  recent: async () => [],
  get: async (_channel, sourceId) => message(Number(BigInt(sourceId) - BigInt(id(0)))),
};
const archive = {
  query: async (sql, args) => ({
    rows: sql.includes("SELECT m.message_id")
      ? args[2].map((message_id) => ({ message_id }))
      : sql.includes("SELECT message_id,created_at FROM messages") && args[5] === "0"
        ? [{ message_id: id(8), created_at: "2026-02-01T00:00:00Z" }]
        : [],
  }),
};

test(
  "failed history retries after 30s/120s then defers durably while direct work and automatic admission continue",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () =>
    isolated(async ({ db, store, directory }) => {
      let clock = Date.parse("2026-02-01T00:00:00Z"),
        content = "memory before retry test";
      const records = [],
        queue = () =>
          historyQueue(
            store,
            transport,
            {},
            directory,
            async (event) => records.push(event),
            archive,
            { now: () => clock },
          );
      const bad = await add(db, "bad", 1),
        good = await add(db, "good", 2);
      const memory = {
        read: async () => ({ content, revision: digest(content) }),
        write: async (input) => {
          content = input.content;
        },
      };
      const finish = async (batch) => {
        await store.prepare(
          (await store.meta()).epoch,
          batch,
          { content: content + "+reviewed", expectedRevision: digest(content) },
          batch.replyTo ? "Fixture reply" : null,
          batch.rows.map((row) => row.id),
        );
        await store.finish(memory);
      };
      let running = queue();
      assert.equal((await running.next()).historyEpisode, bad);
      const first = await running.failEpisode(bad, new Error("Model omitted decisions"), {
        phase: "model",
      });
      assert.equal(first.status, "retry");
      assert.equal(Date.parse(first.nextAttemptAt), clock + 30000);
      const next = await running.next();
      assert.equal(next.historyEpisode, good);
      await finish(next);
      await store.ingest(sourceRecord(message(3), guildId, channelId), true);
      const direct = await store.next();
      assert.equal(direct.replyTo, id(3));
      await finish(direct);
      assert.equal(await running.next(), null, "backoff is scheduling, never a blocking sleep");
      clock += 30000;
      running = queue();
      assert.equal(
        (await running.next()).historyEpisode,
        bad,
        "worker replacement retains the due retry",
      );
      const second = await running.failEpisode(bad, new Error("Schema still invalid"), {
        phase: "model",
      });
      assert.equal(second.retryIndex, 2);
      assert.equal(Date.parse(second.nextAttemptAt), clock + 120000);
      assert.equal(
        await running.failEpisode(bad, { code: "HISTORY_PREEMPTED" }, { phase: "model" }),
        null,
      );
      assert.equal(
        await running.failEpisode(bad, new Error("Aborted"), { phase: "model", stopping: true }),
        null,
      );
      assert.equal(
        await running.failEpisode(bad, { code: "ECONNRESET" }, { phase: "model" }),
        null,
      );
      assert.equal(
        (await db.query("SELECT failure_count FROM pilot_history_episodes WHERE id=$1", [bad]))
          .rows[0].failure_count,
        2,
      );
      clock += 120000;
      assert.equal((await running.next()).historyEpisode, bad);
      const third = await running.failEpisode(bad, new Error("Third failed completion"), {
        phase: "model",
      });
      assert.equal(third.status, "deferred");
      assert.equal(third.nextAttemptAt, null);
      const saved = (
        await db.query(
          "SELECT status,read_ids,failure_count FROM pilot_history_episodes WHERE id=$1",
          [bad],
        )
      ).rows[0];
      assert.deepEqual(saved, { status: "deferred", read_ids: [], failure_count: 3 });
      const failures = (
        await db.query(
          "SELECT attempt_no,retry_index,outcome FROM pilot_history_failures WHERE episode_id=$1 ORDER BY attempt_no",
          [bad],
        )
      ).rows;
      assert.deepEqual(
        failures.map((entry) => entry.attempt_no),
        [1, 2, 3],
      );
      assert.deepEqual(
        failures.map((entry) => entry.outcome),
        ["retry", "retry", "deferred"],
      );
      for (const sql of [
        "UPDATE pilot_history_failures SET phase='changed'",
        "DELETE FROM pilot_history_failures",
        "TRUNCATE pilot_history_failures",
      ])
        await assert.rejects(db.query(sql), /append-only/);
      await writeFile(
        join(directory, "history-automation.json"),
        JSON.stringify({
          id: "continuing",
          enabled: true,
          channels: [
            { guildId, channelId, start: "2026-02-01T00:00:00Z", end: "2026-02-02T00:00:00Z" },
          ],
          cooldownSeconds: 0,
        }),
      );
      const automatic = await queue().next();
      assert.ok(automatic.historyEpisode.startsWith("auto-"));
      assert.deepEqual(
        automatic.rows.map((row) => row.id),
        [id(8)],
      );
      assert.equal(records.filter((event) => event.type === "history_episode_failure").length, 3);
      await store.ingest(
        { ...sourceRecord(message(1), guildId, channelId), content: "Edited historical source" },
        false,
        false,
      );
      const edited = (
        await db.query(
          "SELECT status,failure_count,next_attempt_at FROM pilot_history_episodes WHERE id=$1",
          [bad],
        )
      ).rows[0];
      assert.deepEqual(
        edited,
        { status: "queued", failure_count: 0, next_attempt_at: null },
        "a real edit also requeues a deferred target that never had a read receipt",
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM pilot_history_failures WHERE episode_id=$1",
            [bad],
          )
        ).rows[0].n,
        3,
        "source edits never erase prior failure evidence",
      );
    }),
);

test(
  "prepared/committed history is recovered instead of retried, malformed selections and admissions do not halt other work",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () =>
    isolated(async ({ db, store, directory }) => {
      let content = "existing useful memory";
      const memory = {
        read: async () => ({ content, revision: digest(content) }),
        write: async (input) => {
          content = input.content;
        },
      };
      const queue = () => historyQueue(store, transport, {}, directory, async () => {}, archive);
      const preparedId = await add(db, "prepared", 4);
      const running = queue(),
        prepared = await running.next();
      const workId = await store.prepare(
        (await store.meta()).epoch,
        prepared,
        { content: "durable candidate", expectedRevision: digest(content) },
        null,
        [id(4)],
      );
      assert.equal(
        await running.failEpisode(preparedId, new Error("Late model error"), { phase: "model" }),
        null,
      );
      assert.equal(
        (await db.query("SELECT status FROM pilot_work WHERE id=$1", [workId])).rows[0].status,
        "prepared",
      );
      await store.finish(memory);
      assert.equal(content, "durable candidate");
      assert.equal(
        await running.failEpisode(preparedId, new Error("Postcommit logging error"), {
          phase: "model",
        }),
        null,
      );
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM pilot_history_failures")).rows[0].n,
        0,
      );
      const invalidId = await add(db, "malformed", 5, { sourceIds: ["not-a-message-id"] });
      const healthyId = await add(db, "healthy", 6);
      await writeFile(join(directory, "history-pass.json"), "{broken JSON");
      const healthy = await queue().next();
      assert.equal(healthy.historyEpisode, healthyId);
      await store.prepare(
        (await store.meta()).epoch,
        healthy,
        { content, expectedRevision: digest(content) },
        null,
        [id(6)],
      );
      await store.finish(memory);
      const malformed = queue();
      await assert.rejects(malformed.next(), /Invalid or overlapping/);
      assert.equal(
        malformed.activeEpisode,
        invalidId,
        "invalid source IDs do not crash SQL sorting before attribution",
      );
      assert.equal(
        (
          await malformed.failEpisode(invalidId, new Error("Invalid episode selection"), {
            phase: "history_load",
          })
        ).status,
        "retry",
      );
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM pilot_history_admission_failures")).rows[0]
          .n,
        1,
      );
      assert.equal(await readFile(join(directory, "history-pass.json"), "utf8"), "{broken JSON");
      await assert.rejects(db.query("DELETE FROM pilot_history_admission_failures"), /append-only/);
      assert.equal(
        (await db.query("SELECT status FROM pilot_history_episodes WHERE id=$1", [preparedId]))
          .rows[0].status,
        "done",
      );
    }),
);

test(
  "a poison prepared historical candidate is quarantined only while authoritative PG memory remains at its parent; direct work continues and landed writes reconcile",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () =>
    isolated(async ({ db, store, directory }) => {
      const { encodeUnderstanding } = await import("./pilot-memory.mjs");
      const { postgresUnderstanding } = await import("./pilot-memory-postgres.mjs");
      const entry = (key, n) => ({
        key,
        kind: "statement",
        subjects: [message(n).author.id],
        statement: "Existing useful sourced understanding",
        importance: 2,
        evidence: [{ messageId: id(n), quote: message(n).content }],
        sourceIds: [id(n)],
        created: "2026-02-01",
        updated: "2026-02-01",
      });
      const initial = encodeUnderstanding([entry("survives", 9)]),
        revision = digest(initial);
      const memory = await postgresUnderstanding(
        db,
        {
          read: async () => ({ content: initial, revision }),
          legacy: async () => ({ content: initial, revision }),
        },
        { agentId: "fixture-existing-agent" },
      );
      const queue = () => historyQueue(store, transport, {}, directory, async () => {}, archive);
      const handler = queue();
      const poisonId = await add(db, "poison", 1),
        poison = await queue().next();
      const candidate = {
        content: "not structured understanding",
        expectedRevision: revision,
        audit: [{ unchanged: "preserved diagnostic" }],
      };
      const poisonedWork = await store.prepare(
        (await store.meta()).epoch,
        poison,
        candidate,
        null,
        [id(1)],
      );
      await store.ingest(sourceRecord(message(3), guildId, channelId), true);
      const direct = await store.next();
      const directWork = await store.prepare(
        (await store.meta()).epoch,
        direct,
        { content: initial, expectedRevision: revision },
        "A direct fixture reply",
        [id(3)],
      );
      const options = { onHistoricalFailure: handler.deferCandidate };
      const result = await store.finish(memory, options);
      assert.deepEqual(result.deferred, [poisonedWork]);
      assert.deepEqual(result.completed, [directWork]);
      assert.equal((await memory.read()).content, initial, "the useful parent memory is unchanged");
      const saved = (
        await db.query("SELECT status,candidate FROM pilot_work WHERE id=$1", [poisonedWork])
      ).rows[0];
      assert.equal(saved.status, "deferred");
      assert.deepEqual(saved.candidate, candidate);
      const episode = (
        await db.query("SELECT status,read_ids FROM pilot_history_episodes WHERE id=$1", [poisonId])
      ).rows[0];
      assert.deepEqual(episode, { status: "deferred", read_ids: [] });
      assert.equal(
        (await db.query("SELECT status FROM pilot_outbox WHERE source_id=$1", [id(3)])).rows[0]
          .status,
        "ready",
      );
      const diagnostic = (
        await db.query("SELECT detail,outcome FROM pilot_history_failures WHERE episode_id=$1", [
          poisonId,
        ])
      ).rows[0];
      assert.equal(diagnostic.outcome, "deferred-candidate");
      assert.equal(diagnostic.detail.writeLanded, false);
      assert.equal(diagnostic.detail.currentRevision, revision);
      const landedId = await add(db, "landed", 10),
        landed = await queue().next();
      const nextContent = encodeUnderstanding([entry("survives", 9), entry("later", 10)]);
      const landedWork = await store.prepare(
        (await store.meta()).epoch,
        landed,
        { content: nextContent, expectedRevision: revision },
        null,
        [id(10)],
      );
      let writes = 0;
      const afterCommitFailure = {
        ...memory,
        write: async (...args) => {
          writes++;
          await memory.write(...args);
          throw new Error("Lost acknowledgment after commit");
        },
      };
      const recovered = await store.finish(afterCommitFailure, options);
      assert.deepEqual(recovered.completed, [landedWork]);
      assert.equal(writes, 1, "no candidate or model replay after the write lands");
      assert.equal(
        (await db.query("SELECT status FROM pilot_history_episodes WHERE id=$1", [landedId]))
          .rows[0].status,
        "done",
      );
      assert.equal(
        (
          await db.query("SELECT outcome FROM pilot_history_failures WHERE episode_id=$1", [
            landedId,
          ])
        ).rows[0].outcome,
        "committed-recovery",
      );
      const infrastructureId = await add(db, "infrastructure", 11),
        infrastructure = await queue().next();
      const thirdContent = encodeUnderstanding([
        entry("survives", 9),
        entry("later", 10),
        entry("third", 11),
      ]);
      const infrastructureWork = await store.prepare(
        (await store.meta()).epoch,
        infrastructure,
        { content: thirdContent, expectedRevision: digest(nextContent) },
        null,
        [id(11)],
      );
      await assert.rejects(
        store.finish(
          {
            ...memory,
            write: async () => {
              throw Object.assign(new Error("Connection lost"), { code: "ECONNRESET" });
            },
          },
          options,
        ),
        /Connection lost/,
      );
      assert.equal(
        (await db.query("SELECT status FROM pilot_work WHERE id=$1", [infrastructureWork])).rows[0]
          .status,
        "prepared",
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM pilot_history_failures WHERE episode_id=$1",
            [infrastructureId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal((await memory.read()).content, nextContent);
      const work = (await db.query("SELECT * FROM pilot_work WHERE id=$1", [infrastructureWork]))
        .rows[0];
      await memory.write({
        content: encodeUnderstanding([
          entry("survives", 9),
          entry("later", 10),
          entry("other", 12),
        ]),
        expectedRevision: digest(nextContent),
      });
      assert.equal(
        await handler.deferCandidate(work, new Error("Expected version 2 understanding"), {
          landed: false,
          currentRevision: digest(nextContent),
        }),
        null,
        "the PG row lock rejects stale proof after another revision lands",
      );
      assert.equal(
        (await db.query("SELECT status FROM pilot_work WHERE id=$1", [infrastructureWork])).rows[0]
          .status,
        "prepared",
      );
    }),
);

test(
  "bounded request intake admits new manual work behind completed manifests before automatic generation and yields between files",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () =>
    isolated(async ({ db, store, directory }) => {
      const { stageHistoryRequest } = await import("./pilot-history.mjs");
      const paths = [];
      for (let i = 0; i < 6; i++) {
        const pass = { id: `a-old-${i}`, episodes: [manifest("done", 20 + i)] };
        paths.push(await stageHistoryRequest(directory, pass, {}));
        await db.query("INSERT INTO pilot_history_passes(id,manifest) VALUES($1,$2)", [
          pass.id,
          pass,
        ]);
        await db.query(
          "INSERT INTO pilot_history_episodes(id,pass_id,manifest,status,read_ids) VALUES($1,$2,$3,'done',$4)",
          [`${pass.id}:done`, pass.id, pass.episodes[0], [id(20 + i)]],
        );
        if (i === 0) {
          const path = join(directory, "history-pass.json");
          await writeFile(path, JSON.stringify(pass));
          paths.push(path);
        }
      }
      const fresh = { id: "z-manual", episodes: [manifest("new", 18)] };
      paths.push(await stageHistoryRequest(directory, fresh, {}));
      const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
      await writeFile(
        join(directory, "history-automation.json"),
        JSON.stringify({
          id: "automatic",
          enabled: true,
          channels: [
            { guildId, channelId, start: "2026-02-01T00:00:00Z", end: "2026-02-02T00:00:00Z" },
          ],
          cooldownSeconds: 0,
        }),
      );
      let automaticSelections = 0;
      const watchedArchive = {
        query: async (sql, args) => {
          if (sql.includes("SELECT message_id,created_at FROM messages")) automaticSelections++;
          return archive.query(sql, args);
        },
      };
      const queue = historyQueue(store, transport, {}, directory, async () => {}, watchedArchive);
      const batch = await queue.next();
      assert.equal(
        batch.historyEpisode,
        "z-manual:new",
        "the new eighth request reaches the queue before an automatic model window",
      );
      assert.equal(automaticSelections, 0);
      assert.deepEqual(
        await Promise.all(paths.map((path) => readFile(path, "utf8"))),
        before,
        "all immutable request bytes survive intake",
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM pilot_history_episodes WHERE status='done'",
          )
        ).rows[0].n,
        6,
        "completed read receipts are not reset",
      );
      let checks = 0;
      const yielding = historyQueue(
        store,
        transport,
        {},
        directory,
        async () => {},
        watchedArchive,
        { shouldYield: async () => ++checks === 2 },
      );
      assert.equal(await yielding.next(), null, "live work yields after the first intake file");
      assert.equal(checks, 2);
      assert.equal(automaticSelections, 0);
      assert.equal(
        (await db.query("SELECT read_ids FROM pilot_history_episodes WHERE id='z-manual:new'"))
          .rows[0].read_ids.length,
        0,
        "intake and loading cannot claim a reviewed read",
      );
    }),
);
