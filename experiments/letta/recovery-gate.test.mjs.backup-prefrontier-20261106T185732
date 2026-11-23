import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { state } from "./runtime.mjs";
import { pilotStore, sourceRecord, deliver, digest } from "./pilot-store.mjs";
import { pollLiveChannels } from "./pilot-live-channels.mjs";
import { historyQueue } from "./pilot-history.mjs";
import { postgresUnderstanding } from "./pilot-memory-postgres.mjs";
import { encodeUnderstanding } from "./pilot-memory.mjs";

// The fallback seeds the future durable record against unchanged code. Red proof
// exercises real existing mutations/callbacks, rather than merely missing imports.
const recovery = await import("./pilot-recovery.mjs").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return null;
  throw error;
});
const config = { guildId: "111111111111111111", channelId: "222222222222222222" };
const a = "555555555555555501",
  b = "555555555555555502",
  frontier = "555555555555555550";
const value = (id = a, content = "Fictional recovery fixture") =>
  sourceRecord(
    {
      id,
      channel_id: config.channelId,
      author: { id: "333333333333333333", username: "Fixture" },
      content,
      timestamp: "2026-01-01T00:00:00Z",
      type: 0,
    },
    config.guildId,
    config.channelId,
  );
const policy = {
  version: 1,
  phase: "held",
  revision: 1,
  baseline: "a".repeat(64),
  protectedSourceIds: [a],
  frontiers: {},
  reason: "Fictional provisional qualification",
};
const database = { skip: process.env.CHECK_DATABASE !== "1" };

async function fixture(label, run) {
  const settings = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
  const schema = `recovery_gate_${label}_${Date.now()}`;
  const clients = new Set();
  const directory = await mkdtemp(join(tmpdir(), "recovery-gate-fictional-"));
  const connect = async () => {
    const db = new pg.Client(settings);
    await db.connect();
    clients.add(db);
    await db.query(`SET search_path TO ${schema}`);
    return db;
  };
  const db = await connect();
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    const store = await pilotStore(db, config);
    await store.ingest(value(a), true);
    await store.ingest(value(b), true);
    await store.queueReply(b, "Fictional unrelated ready reply");
    await db.query(
      "INSERT INTO pilot_work(id,epoch,source_ids,candidate,status) VALUES('fictional-work',0,$1,$2,'prepared')",
      [[b], { content: "fictional candidate", expectedRevision: digest("prior") }],
    );
    await db.query(
      "CREATE TABLE pilot_memory_fixture(id int PRIMARY KEY,content text); INSERT INTO pilot_memory_fixture VALUES(1,'fictional protected memory')",
    );
    const hold = async () => {
      if (recovery)
        return recovery.holdRecovery(db, {
          baseline: policy.baseline,
          protectedSourceIds: [a],
          reason: policy.reason,
        });
      await db.query(
        "CREATE TABLE pilot_recovery_policy(id boolean PRIMARY KEY DEFAULT true CHECK(id),policy jsonb NOT NULL)",
      );
      await db.query("INSERT INTO pilot_recovery_policy(policy) VALUES($1)", [policy]);
      return policy;
    };
    const snapshot = async () => {
      const result = {};
      for (const table of [
        "pilot_meta",
        "pilot_sources",
        "pilot_source_holds",
        "pilot_work",
        "pilot_outbox",
        "pilot_memory_fixture",
        "pilot_history_episodes",
        "pilot_history_passes",
      ])
        result[table] = (
          await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)
        ).rows;
      return result;
    };
    await run({
      db,
      store,
      hold,
      snapshot,
      connect,
      directory,
      close: async (client) => {
        await client.end();
        clients.delete(client);
      },
    });
  } finally {
    for (const client of clients) await client.end();
    const clean = new pg.Client(settings);
    await clean.connect();
    try {
      await clean.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await clean.end();
    }
    await rm(directory, { recursive: true, force: true });
  }
}

for (const operation of ["ingest", "remove", "finish", "reset", "queueReply", "raw-memory"]) {
  test(
    `held recovery rejects ${operation} before any protected state or callback change`,
    database,
    () =>
      fixture(operation.replaceAll("-", "_"), async ({ db, store, hold, snapshot }) => {
        if (operation === "reset") await db.query("UPDATE pilot_meta SET rebuild=true");
        await hold();
        const before = await snapshot();
        let callbacks = 0;
        const memory = {
          read: async () => {
            callbacks++;
            return { revision: digest("prior") };
          },
          write: async () => {
            callbacks++;
          },
        };
        const calls = {
          ingest: () => store.ingest(value(a, "Fictional edited content"), true),
          remove: () => store.remove(a),
          finish: () => store.finish(memory),
          reset: () => store.reset(memory),
          queueReply: () => store.queueReply(a, "Fictional blocked reply"),
          "raw-memory": () => db.query("UPDATE pilot_memory_fixture SET content='forbidden'"),
        };
        await assert.rejects(calls[operation], /recovery/i);
        assert.equal(callbacks, 0);
        assert.deepEqual(await snapshot(), before);
      }),
  );
}

test("held recovery survives reopen and blocks startup before reclassification", database, () =>
  fixture("restart", async ({ db, hold, snapshot, close, connect }) => {
    await db.query("UPDATE pilot_outbox SET status='sent',discord_id=$1", ["555555555555555599"]);
    await db.query(
      "UPDATE pilot_sources SET addressed=false,source=jsonb_set(source,'{replyTo}',to_jsonb($1::text)) WHERE id=$2",
      ["555555555555555599", a],
    );
    await hold();
    const before = await snapshot();
    await close(db);
    const reopened = await connect();
    await assert.rejects(pilotStore(reopened, config), /recovery/i);
    assert.equal(
      (await reopened.query("SELECT addressed FROM pilot_sources WHERE id=$1", [a])).rows[0]
        .addressed,
      false,
    );
    if (recovery) assert.equal((await recovery.readRecoveryPolicy(reopened)).phase, "held");
    assert(before.pilot_sources.length === 2);
  }),
);

test("held recovery prevents old and missing route polling before mocked reads", database, () =>
  fixture("poll", async ({ store, hold, snapshot }) => {
    await store.cursor(a, config.channelId);
    await hold();
    const before = await snapshot();
    let callbacks = 0;
    const discord = {
      after: async () => {
        callbacks++;
        return [];
      },
      recent: async () => {
        callbacks++;
        return [];
      },
    };
    await assert.rejects(
      pollLiveChannels(store, discord, config, [config.channelId, "222222222222222223"]),
      /recovery/i,
    );
    assert.equal(callbacks, 0);
    assert.deepEqual(await snapshot(), before);
  }),
);

test(
  "held recovery prevents interrupted and ready dispatch before external calls or status changes",
  database,
  () =>
    fixture("dispatch", async ({ db, store, hold, snapshot }) => {
      await hold();
      const before = await snapshot();
      let callbacks = 0;
      const discord = {
        after: async () => {
          callbacks++;
          return [];
        },
        send: async () => {
          callbacks++;
          return { id: "555555555555555599" };
        },
      };
      await assert.rejects(
        deliver(store, discord, "444444444444444444", config.channelId, async () => {}),
        /recovery/i,
      );
      assert.equal(callbacks, 0);
      assert.deepEqual(await snapshot(), before);
    }),
);

test(
  "held and live-only recovery prohibit already queued history before archive or Discord reads",
  database,
  () =>
    fixture("history", async (ctx) => {
      const episode = {
        key: "one",
        label: "Fictional history",
        guildId: config.guildId,
        channelId: config.channelId,
        sourceIds: [a],
        contextIds: [],
      };
      await ctx.db.query(
        "INSERT INTO pilot_history_episodes(id,pass_id,manifest) VALUES('fictional-pass:one','fictional-pass',$1)",
        [episode],
      );
      await writeFile(
        join(ctx.directory, "history-automation.json"),
        JSON.stringify({ enabled: false }),
        { mode: 0o600 },
      );
      await ctx.hold();
      const before = await ctx.snapshot();
      let callbacks = 0;
      const archive = {
        query: async () => {
          callbacks++;
          throw new Error("Fictional archive reached");
        },
      };
      const queue = historyQueue(ctx.store, {}, config, ctx.directory, async () => {}, archive);
      await assert.rejects(queue.next(), /recovery/i);
      assert.equal(callbacks, 0);
      assert.deepEqual(await ctx.snapshot(), before);
      if (recovery) {
        await recovery.releaseRecovery(ctx.db, {
          expectedRevision: 1,
          reason: "Fictional explicit live-only release",
          frontiers: { [config.channelId]: frontier },
          confirmLiveOnly: true,
        });
        await assert.rejects(queue.next(), /recovery/i);
        assert.equal(callbacks, 0);
      }
    }),
);

test(
  "actual session ownership is checked before Discord identity, archive and model callbacks",
  database,
  () =>
    fixture("owner", async ({ connect }) => {
      const contender = await connect();
      let callbacks = 0;
      const callback = async () => {
        callbacks++;
      };
      const boundary = recovery?.ownedExternal ?? (async (_db, _kind, fn) => fn());
      for (const kind of ["startup", "history", "model"])
        await assert.rejects(boundary(contender, kind, callback), /owns|ownership/i);
      assert.equal(callbacks, 0);
    }),
);

test(
  "release is revision-matched and audited, retains quarantine/history denial and rejects old/new routes",
  database,
  () =>
    fixture("release", async ({ db, store, hold, connect, close, snapshot }) => {
      await hold();
      assert(recovery, "persistent recovery administration must exist");
      await assert.rejects(
        recovery.releaseRecovery(db, {
          expectedRevision: 2,
          reason: "stale",
          frontiers: { [config.channelId]: frontier },
          confirmLiveOnly: true,
        }),
        /revision/i,
      );
      await assert.rejects(
        recovery.releaseRecovery(db, {
          expectedRevision: 1,
          reason: "",
          frontiers: { [config.channelId]: frontier },
          confirmLiveOnly: true,
        }),
        /reason/i,
      );
      await assert.rejects(
        recovery.releaseRecovery(db, {
          expectedRevision: 1,
          reason: "no frontier",
          frontiers: {},
          confirmLiveOnly: true,
        }),
        /frontier/i,
      );
      await recovery.releaseRecovery(db, {
        expectedRevision: 1,
        reason: "Fictional reviewed live-only release",
        frontiers: { [config.channelId]: frontier },
        confirmLiveOnly: true,
      });
      const before = await snapshot();
      await assert.rejects(store.ingest(value(a, "Fictional forbidden edit")), /recovery/i);
      await assert.rejects(store.remove(a), /recovery/i);
      const calls = [];
      const discord = {
        after: async (channel, id) => {
          calls.push([channel, id]);
          return [];
        },
        recent: async () => {
          throw new Error("recent must never occur");
        },
      };
      await assert.rejects(
        pollLiveChannels(store, discord, config, ["222222222222222223"]),
        /recovery/i,
      );
      await pollLiveChannels(store, discord, config);
      assert.deepEqual(calls, [[config.channelId, frontier]]);
      assert.deepEqual(await snapshot(), before);
      const live = value("555555555555555551");
      await store.ingest(live, true);
      assert.equal((await store.next()).replyTo, live.id);
      await close(db);
      const again = await connect();
      assert.equal((await recovery.readRecoveryPolicy(again)).phase, "live-only");
      const policyAfter = await recovery.readRecoveryPolicy(again);
      assert.deepEqual(policyAfter.protectedSourceIds, [a]);
      assert.equal(policyAfter.baseline, policy.baseline);
      assert.equal(
        (await again.query("SELECT count(*)::int n FROM pilot_recovery_audit")).rows[0].n,
        2,
      );
    }),
);

test("an existing empty or invalid recovery policy fails closed", database, () =>
  fixture("corrupt", async ({ db, store, hold }) => {
    await hold();
    assert(recovery, "persistent recovery validation must exist");
    // Privileged corruption simulation, not a supported release operation.
    await db.query("UPDATE pilot_recovery_policy SET policy=jsonb_set(policy,'{version}','999')");
    await assert.rejects(store.ingest(value(a)), /recovery/i);
    await assert.rejects(
      db.query("UPDATE pilot_memory_fixture SET content='forbidden'"),
      /recovery/i,
    );
    await db.query("UPDATE pilot_recovery_policy SET policy=$1", [policy]);
    await db.query("UPDATE pilot_recovery_policy SET policy=policy-'phase'");
    await assert.rejects(
      db.query("UPDATE pilot_memory_fixture SET content='forbidden'"),
      /recovery/i,
    );
    const malformed = [
      { ...policy, version: "1" },
      { ...policy, revision: "1" },
      { ...policy, reason: 123 },
      { ...policy, protectedSourceIds: [555555555555555501] },
      { ...policy, frontiers: { [config.channelId]: 555555555555555550 } },
      { ...policy, protectedSourceIds: [a, a] },
      { ...policy, extraAuthority: true },
    ];
    for (const bad of malformed) {
      await db.query("UPDATE pilot_recovery_policy SET policy=$1", [bad]);
      await assert.rejects(store.ingest(value(a)), /recovery/i);
      await assert.rejects(
        db.query("UPDATE pilot_memory_fixture SET content='forbidden'"),
        /recovery/i,
      );
    }
    await db.query("DELETE FROM pilot_recovery_policy");
    await assert.rejects(store.ingest(value(a)), /recovery/i);
    await assert.rejects(
      db.query("UPDATE pilot_memory_fixture SET content='forbidden'"),
      /recovery/i,
    );
  }),
);

test(
  "live-only preflights an entire mixed route batch and rejects returned pre-frontier originals",
  database,
  () =>
    fixture("mixed", async ({ db, store, hold, snapshot }) => {
      await hold();
      await recovery.releaseRecovery(db, {
        expectedRevision: 1,
        reason: "Fictional route review",
        frontiers: { [config.channelId]: frontier },
        confirmLiveOnly: true,
      });
      const before = await snapshot();
      let calls = 0;
      const discord = {
        after: async () => {
          calls++;
          return [];
        },
        recent: async () => {
          calls++;
          return [];
        },
      };
      await assert.rejects(
        pollLiveChannels(store, discord, config, [config.channelId, "222222222222222223"]),
        /recovery/i,
      );
      assert.equal(calls, 0);
      await assert.rejects(
        pollLiveChannels(
          store,
          { after: async () => [{ id: a, channel_id: config.channelId }] },
          config,
        ),
        /recovery/i,
      );
      assert.deepEqual(await snapshot(), before);
    }),
);

test(
  "live-only denies edits/removals before global invalidation and skips old prepared memory work",
  database,
  () =>
    fixture("live_append", async ({ db, store, hold, snapshot }) => {
      await db.query(
        "INSERT INTO pilot_source_holds(source_id,reason) VALUES($1,'Fictional prior hold: preserve full row')",
        [a],
      );
      await hold();
      await recovery.releaseRecovery(db, {
        expectedRevision: 1,
        reason: "Fictional live-only review",
        frontiers: { [config.channelId]: frontier },
        confirmLiveOnly: true,
      });
      const live = value("555555555555555551");
      await store.ingest(live, true);
      const before = await snapshot();
      for (const source of [
        value(a, "Forbidden held edit"),
        { ...live, content: "Forbidden fresh-live edit" },
      ])
        await assert.rejects(store.ingest(source, true), /recovery/i);
      await assert.rejects(store.remove(a), /recovery/i);
      await assert.rejects(store.remove(live.id), /recovery/i);
      assert.deepEqual(await snapshot(), before);
      let callbacks = 0;
      const memory = {
        read: async () => {
          callbacks++;
          return { revision: digest("prior") };
        },
        write: async () => {
          callbacks++;
        },
      };
      assert.deepEqual((await store.finish(memory)).completed, []);
      assert.equal(callbacks, 0);
      assert.deepEqual(await snapshot(), before);
      const batch = await store.next();
      const id = await store.prepare(
        0,
        batch,
        { content: "Fictional new memory", expectedRevision: digest("prior") },
        "Fictional live reply",
      );
      assert.deepEqual((await store.finish(memory)).completed, [id]);
      assert.equal(callbacks, 2);
      assert.equal(
        (await db.query("SELECT status FROM pilot_work WHERE id='fictional-work'")).rows[0].status,
        "prepared",
      );
      assert.equal(
        (await db.query("SELECT status FROM pilot_outbox WHERE source_id=$1", [b])).rows[0].status,
        "ready",
      );
    }),
);

test(
  "session preflight does not stack locks and detects ownership loss before callbacks",
  database,
  () =>
    fixture("lockloss", async ({ db, connect }) => {
      await recovery.ownedExternal(db, "startup", async () => {});
      await recovery.ownedExternal(db, "startup", async () => {});
      assert.equal(
        (await db.query("SELECT pg_advisory_unlock(1560387,1127029) AS unlocked")).rows[0].unlocked,
        true,
      );
      assert.equal(
        (await db.query("SELECT pg_advisory_unlock(1560387,1127029) AS unlocked")).rows[0].unlocked,
        false,
      );
      const successor = await connect();
      await recovery.claimPilotOwnership(successor);
      let callbacks = 0;
      await assert.rejects(
        recovery.ownedExternal(db, "model", async () => {
          callbacks++;
        }),
        /owns|ownership/i,
      );
      assert.equal(callbacks, 0);
    }),
);

test(
  "guarded transport and parent-source lookup refuse protected reads before external callbacks",
  database,
  () =>
    fixture("transport", async ({ db, store, hold }) => {
      await hold();
      let callbacks = 0;
      const transport = recovery.recoveryTransport(
        db,
        new Proxy(
          {},
          {
            get: () => async () => {
              callbacks++;
              return [];
            },
          },
        ),
      );
      await assert.rejects(transport.me(), /recovery/i);
      assert.equal(callbacks, 0);
      await recovery.releaseRecovery(db, {
        expectedRevision: 1,
        reason: "Fictional transport review",
        frontiers: { [config.channelId]: frontier },
        confirmLiveOnly: true,
      });
      for (const fn of [
        () => transport.get(config.channelId, a),
        () => transport.recent(config.channelId),
        () => transport.after(config.channelId, a),
        () => transport.react(config.channelId, a, "fixture"),
        () => transport.send(config.channelId, { message_reference: { message_id: a } }),
        () => transport.typing("222222222222222223"),
      ])
        await assert.rejects(fn, /recovery/i);
      const current = { ...value("555555555555555551"), replyTo: a };
      await assert.rejects(
        store.isAddressed(current, "444444444444444444", async () => {
          callbacks++;
          return null;
        }),
        /recovery/i,
      );
      assert.equal(callbacks, 0);
    }),
);

test(
  "held recovery protects complete native memory rows and denies memory factory migration",
  database,
  () =>
    fixture("native_memory", async ({ db, store, hold, snapshot }) => {
      const entry = {
        key: "fictional-note",
        kind: "statement",
        subjects: ["333333333333333333"],
        statement: "Fictional retained understanding",
        evidence: [{ messageId: a, quote: "Fictional retained understanding" }],
        importance: 2,
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
      };
      const content = encodeUnderstanding([entry]),
        legacy = { read: async () => ({ content, revision: digest(content) }) };
      const memory = await postgresUnderstanding(db, legacy, {
        agentId: "fictional-recovery-agent",
      });
      await hold();
      const nativeSnapshot = async () => {
        const out = {};
        for (const table of [
          "pilot_memory_commits",
          "pilot_memory_meta",
          "pilot_memory_migrations",
          "pilot_memory_versions",
          "pilot_memory_entries",
        ])
          out[table] = (
            await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)
          ).rows;
        return out;
      };
      const before = await nativeSnapshot(),
        other = await snapshot();
      await assert.rejects(
        memory.write({ content: encodeUnderstanding([]), expectedRevision: digest(content) }),
        /recovery/i,
      );
      await assert.rejects(memory.invalidate([a]), /recovery/i);
      await assert.rejects(
        postgresUnderstanding(
          db,
          { read: async () => assert.fail("legacy callback forbidden") },
          { agentId: "fictional-recovery-agent" },
        ),
        /recovery/i,
      );
      await assert.rejects(
        db.query("UPDATE pilot_memory_meta SET content='forbidden'"),
        /recovery/i,
      );
      assert.deepEqual(await nativeSnapshot(), before);
      assert.deepEqual(await snapshot(), other);
      await recovery.releaseRecovery(db, {
        expectedRevision: 1,
        reason: "Fictional existing-memory read-only reopen",
        frontiers: { [config.channelId]: frontier },
        confirmLiveOnly: true,
      });
      const reopened = await postgresUnderstanding(
        db,
        {
          read: async () => assert.fail("Live-only startup must not migrate legacy memory"),
        },
        { agentId: "fictional-recovery-agent" },
      );
      assert.deepEqual(reopened.migrationReceipt, memory.migrationReceipt);
      await assert.rejects(
        reopened.write({ content: encodeUnderstanding([]), expectedRevision: digest(content) }),
        /recovery/i,
      );
      assert.deepEqual(await nativeSnapshot(), before);
      assert.deepEqual(await snapshot(), other);
    }),
);

test("policy lookup errors fail before mutation or external callbacks", database, () =>
  fixture("query_failure", async ({ db, store, hold, snapshot }) => {
    await hold();
    const before = await snapshot();
    const query = db.query.bind(db);
    let callbacks = 0;
    db.query = async (sql, ...args) => {
      if (typeof sql === "string" && sql.includes("to_regclass('pilot_recovery_policy')"))
        throw new Error("Recovery lookup unavailable");
      return query(sql, ...args);
    };
    try {
      await assert.rejects(store.ingest(value(a, "Forbidden")), /lookup unavailable/);
      await assert.rejects(
        recovery.ownedExternal(db, "model", async () => {
          callbacks++;
        }),
        /lookup unavailable/,
      );
      assert.equal(callbacks, 0);
    } finally {
      db.query = query;
    }
    assert.deepEqual(await snapshot(), before);
  }),
);
