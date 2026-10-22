import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryPreempted, withLivePriority, livePriorityCheckpoint } from "./pilot-priority.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((accept) => setImmediate(accept));
function fakeTimers() {
  let id = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setTimeout: (callback) => {
      callbacks.set(++id, callback);
      return id;
    },
    clearTimeout: (key) => callbacks.delete(key),
    fire: () => {
      const [key, callback] = callbacks.entries().next().value;
      callbacks.delete(key);
      callback();
    },
  };
}
const incoming = [{ id: "123", content: "A direct live message" }];

test("urgent live input aborts history and waits for action cleanup before handing messages to the caller", async () => {
  const cancelled = deferred(),
    cleanup = deferred(),
    timers = fakeTimers();
  const events = [];
  let cleaned = false,
    completed = false,
    aborts = 0;
  const result = withLivePriority(
    async () => {
      try {
        await cancelled.promise;
        throw new Error("native turn cancelled");
      } finally {
        await cleanup.promise;
        cleaned = true;
      }
    },
    {
      poll: async () => incoming,
      isUrgent: async () => true,
      abort: async () => {
        aborts++;
        cancelled.resolve();
      },
      record: async (event) => events.push(event),
      timers,
    },
  );
  result.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  await tick();
  assert.equal(aborts, 1);
  assert.equal(completed, false, "replacement writer cannot start before cleanup");
  cleanup.resolve();
  await assert.rejects(
    result,
    (error) =>
      error instanceof HistoryPreempted &&
      error.code === "HISTORY_PREEMPTED" &&
      error.messages === incoming,
  );
  assert.equal(cleaned, true);
  assert.equal(events[0].type, "history_preempted");
  assert.deepEqual(events[0].incomingIds, ["123"]);
  assert.equal(timers.callbacks.size, 0);
});

test("nonurgent polling is serial, drains a pending fetch and stops every timer", async () => {
  const done = deferred(),
    fetch = deferred(),
    timers = fakeTimers();
  let calls = 0,
    active = 0,
    peak = 0,
    aborts = 0,
    completed = false;
  const result = withLivePriority(
    async () => {
      await done.promise;
      return "historical result";
    },
    {
      poll: async () => {
        calls++;
        active++;
        peak = Math.max(peak, active);
        try {
          return calls === 1 ? [] : await fetch.promise;
        } finally {
          active--;
        }
      },
      isUrgent: () => false,
      abort: async () => {
        aborts++;
      },
      timers,
    },
  );
  result.then(() => {
    completed = true;
  });
  await tick();
  assert.equal(calls, 1);
  assert.equal(timers.callbacks.size, 1);
  timers.fire();
  await tick();
  assert.equal(calls, 2);
  assert.equal(timers.callbacks.size, 0, "no overlapping interval polls");
  done.resolve();
  await tick();
  assert.equal(completed, false, "a fetch already in flight must drain");
  fetch.resolve([]);
  assert.equal(await result, "historical result");
  assert.equal(peak, 1);
  assert.equal(aborts, 0);
  assert.equal(timers.callbacks.size, 0);
});

test("poll failure stops history and preserves the original failure cause", async () => {
  const cancelled = deferred(),
    original = new Error("Discord network unavailable"),
    timers = fakeTimers();
  let cleaned = false;
  const result = withLivePriority(
    async () => {
      await cancelled.promise;
      cleaned = true;
    },
    {
      poll: async () => {
        throw original;
      },
      isUrgent: () => false,
      abort: async () => cancelled.resolve(),
      timers,
    },
  );
  await assert.rejects(
    result,
    (error) => error.code === "LIVE_PRIORITY_POLL_FAILED" && error.cause === original,
  );
  assert.equal(cleaned, true);
  assert.equal(timers.callbacks.size, 0);
});

test("late urgent messages invalidate a finished historical result before it can commit", async () => {
  const fetch = deferred(),
    timers = fakeTimers();
  let aborts = 0;
  const result = withLivePriority(async () => "finished but not committed", {
    poll: async () => fetch.promise,
    isUrgent: (messages) => messages.length > 0,
    abort: async () => {
      aborts++;
    },
    timers,
  });
  await tick();
  fetch.resolve(incoming);
  await assert.rejects(result, (error) => error.code === "HISTORY_PREEMPTED");
  assert.equal(aborts, 1);
  assert.equal(timers.callbacks.size, 0);
});

test("source checkpoints share one in-flight fetch and report preemption with the actual incoming messages", async () => {
  const fetch = deferred();
  let calls = 0;
  const checkpoint = livePriorityCheckpoint({
    poll: async () => {
      calls++;
      return fetch.promise;
    },
    isUrgent: (messages) => messages.length > 0,
  });
  const first = checkpoint(),
    second = checkpoint();
  fetch.resolve(incoming);
  await Promise.all(
    [first, second].map((promise) =>
      assert.rejects(
        promise,
        (error) => error.code === "HISTORY_PREEMPTED" && error.messages === incoming,
      ),
    ),
  );
  assert.equal(calls, 1);
});

test(
  "direct live work precedes ambient learning, retired preferences do not filter, and durable memory writes carry lineage audit",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    const { default: pg } = await import("pg");
    const { state } = await import("./runtime.mjs");
    const { pilotStore, digest, sourceRecord } = await import("./pilot-store.mjs");
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const admin = new pg.Client(credentials);
    await admin.connect();
    const name = "mudfut_priority_check_" + randomUUID().replaceAll("-", "");
    let db;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      db = new pg.Client({ ...credentials, database: name });
      await db.connect();
      const guildId = "111111111111111111",
        channelId = "222222222222222222",
        authorId = "333333333333333333";
      const store = await pilotStore(db, { guildId, channelId, historyScope: [] });
      const source = (id, channel = channelId) =>
        sourceRecord(
          {
            id,
            channel_id: channel,
            author: { id: authorId, username: "Member" },
            content: "A conversation",
            timestamp: "2025-01-01T00:00:00Z",
          },
          guildId,
          channel,
        );
      await db.query("INSERT INTO pilot_optouts VALUES($1)", [authorId]);
      const ambient = source("555555555555555501"),
        direct = source("555555555555555502");
      await store.ingest(ambient);
      await store.ingest(direct, false, false);
      await store.ingest(direct, true, true);
      const batch = await store.next();
      assert.equal(
        batch.replyTo,
        direct.id,
        "a cached direct address is promoted and skips the older ambient backlog",
      );
      await store.optOut(authorId);
      assert.equal(await store.optedOut(authorId), false);
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM pilot_optouts")).rows[0].n,
        1,
        "legacy audit row survives without active filtering",
      );
      await store.ingest(source("555555555555555503", "777777777777777777"), false, false);
      assert.equal(
        (await store.findSources(["555555555555555503"])).length,
        1,
        "retired historical allowlist is not an ingestion gate",
      );
      let activeTransactions = 0,
        peak = 0;
      const query = db.query.bind(db);
      db.query = async (...args) => {
        if (args[0] === "BEGIN") peak = Math.max(peak, ++activeTransactions);
        try {
          return await query(...args);
        } finally {
          if (args[0] === "COMMIT" || args[0] === "ROLLBACK") activeTransactions--;
        }
      };
      await Promise.all([
        store.ingest(source("555555555555555504")),
        store.ingest(source("555555555555555505")),
      ]);
      assert.equal(peak, 1, "parallel application tools cannot interleave source transactions");
      let content = "before",
        written;
      const candidate = {
        content: "after",
        expectedRevision: digest(content),
        audit: [{ transitions: [{ key: "dated-view", action: "revise", sourceIds: [direct.id] }] }],
      };
      const workId = await store.prepare(
        (await store.meta()).epoch,
        batch,
        candidate,
        "A useful reply",
        [direct.id],
      );
      await store.finish({
        read: async () => ({ content, revision: digest(content) }),
        write: async (input, metadata) => {
          assert.deepEqual(Object.keys(input).sort(), ["content", "expectedRevision"]);
          written = { ...input, ...metadata };
          content = input.content;
        },
      });
      assert.equal(written.workId, workId);
      assert.deepEqual(written.audit, candidate.audit);
      assert.deepEqual(written.sourceIds, [direct.id]);
      assert.equal(
        (await db.query("SELECT status FROM pilot_work WHERE id=$1", [workId])).rows[0].status,
        "done",
      );
      assert.equal((await store.next()).replyTo, null);
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);

test("fresh-page evidence hits checkpoint per REST call rather than per message, and missing originals still yield before exact fetch", async () => {
  const { currentSources } = await import("./pilot-discord.mjs");
  const channelId = "222222222222222222";
  const refs = Array.from({ length: 40 }, (_, i) => ({
    id: String(555555555555555500n + BigInt(i)),
    channelId,
  }));
  let checkpoints = 0,
    pages = 0,
    exact = 0,
    version = "original";
  const discord = {
    recent: async () => {
      pages++;
      return refs.map((source) => ({ id: source.id, content: version }));
    },
    get: async () => {
      exact++;
      return null;
    },
  };
  const check = async () => {
    checkpoints++;
  };
  assert.equal((await currentSources(discord, refs, check)).size, 40);
  assert.equal(checkpoints, 1, "one fresh page needs one live poll, not forty redundant polls");
  assert.equal(exact, 0);
  version = "edited";
  assert.equal(
    (await currentSources(discord, refs, check)).get(refs[0].id).content,
    "edited",
    "the next validation still fetches a fresh page",
  );
  assert.equal(pages, 2);
  assert.equal(checkpoints, 2);
  checkpoints = 0;
  discord.recent = async () => [{ id: refs[0].id, content: version }];
  await assert.rejects(
    currentSources(discord, refs.slice(0, 2), async () => {
      if (++checkpoints === 2) throw new HistoryPreempted(incoming);
    }),
    (error) => error.code === "HISTORY_PREEMPTED" && error.messages === incoming,
  );
  assert.equal(exact, 0, "a live arrival prevents the missing-source REST read");
  const missing = await currentSources(discord, refs.slice(0, 2));
  assert.equal(
    missing.get(refs[1].id),
    null,
    "an absent original is still resolved and reported as deleted",
  );
  assert.equal(exact, 1);
});

test("progress health advances on successful work, throttles to five seconds, coalesces writes and retries failed saves", async () => {
  const { progressPulse } = await import("./pilot-priority.mjs");
  let time = 10000;
  const saved = [],
    gate = deferred();
  let hold = false,
    fail = false;
  const pulse = progressPulse(
    async (receipt) => {
      if (fail) throw new Error("health save failed");
      if (hold) await gate.promise;
      saved.push(receipt);
    },
    { now: () => time },
  );
  assert.equal(await pulse("startup_ready"), true);
  assert.equal(saved[0].at, new Date(10000).toISOString());
  time = 14999;
  assert.equal(await pulse("live_poll_complete"), false);
  assert.equal(saved.length, 1);
  time = 15000;
  assert.equal(await pulse("memory_commit_complete"), true);
  assert.equal(saved[1].progress, "memory_commit_complete");
  assert.ok(Date.parse(saved[1].at) > Date.parse(saved[0].at));
  time = 20000;
  fail = true;
  await assert.rejects(pulse("live_poll_complete"), /health save failed/);
  fail = false;
  hold = true;
  const first = pulse("live_poll_complete"),
    second = pulse("cycle_complete");
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(
    saved.length,
    3,
    "failed saves never throttle a retry; concurrent calls share a single write",
  );
  time = 5000;
  assert.equal(
    await pulse("live_poll_complete"),
    true,
    "a backwards wall-clock step cannot suppress health indefinitely",
  );
  assert.equal(saved.at(-1).at, new Date(5000).toISOString());
  assert.throws(() => progressPulse(async () => {}, { minIntervalMs: 4999 }), /five seconds/);
});
