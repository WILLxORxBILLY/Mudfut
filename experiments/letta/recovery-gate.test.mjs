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
import { archiveTool } from "./pilot-discord.mjs";
import { archiveDiscussions } from "./pilot-discussions.mjs";
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
// Seeds a source row as pre-existing historical state, bypassing the write guard
// the way a pre-policy ingest would have. Used only to reproduce production shape.
async function seedHistorical(db, id, content) {
  await db.query("ALTER TABLE pilot_sources DISABLE TRIGGER USER");
  try {
    await db.query(
      `INSERT INTO pilot_sources(id,source,hash,deleted,learnable)
       VALUES($1,$2,$3,false,true)`,
      [
        id,
        {
          id,
          channelId: config.channelId,
          guildId: config.guildId,
          content,
          createdAt: "2026-01-01T00:00:00Z",
        },
        digest(content),
      ],
    );
  } finally {
    await db.query("ALTER TABLE pilot_sources ENABLE TRIGGER USER");
  }
}
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
  "live-only permits read-only archive recall while derivation and pre-boot history stay closed",
  database,
  () =>
    fixture("archive_read", async ({ db, store, hold, snapshot }) => {
      // A real (if empty) queue directory: this proves the admission path, not a
      // merely absent archive client.
      const directory = await mkdtemp(join(tmpdir(), "recovery-archive-read-"));
      try {
        const episode = {
          key: "one",
          label: "Fictional history",
          guildId: config.guildId,
          channelId: config.channelId,
          sourceIds: [a],
          contextIds: [],
        };
        await db.query(
          "INSERT INTO pilot_history_episodes(id,pass_id,manifest) VALUES('fictional-pass:one','fictional-pass',$1)",
          [episode],
        );
        // Pre-boot (pre-frontier, unprotected) history that must never be admitted.
        const preBoot = value(b, "Fictional pre-boot history");
        const original = {
          id: preBoot.id,
          channel_id: config.channelId,
          guild_id: config.guildId,
          author: { id: preBoot.authorId, username: "Fixture" },
          content: preBoot.content,
          timestamp: preBoot.createdAt,
          type: 0,
        };
        const discord = { get: async (_channel, id) => ({ ...original, id }) };
        const calls = [];
        const archive = {
          async query(sql, args) {
            calls.push(sql);
            if (/^\s*BEGIN/i.test(sql) || /^\s*(COMMIT|ROLLBACK)/i.test(sql))
              return { rows: [], rowCount: 0 };
            // Anchor/exact reads answer with the pre-boot original only; neighbor
            // and gap queries stay empty so the shape stays simple.
            if (
              /m\.message_id=\$1|m\.message_id=\$1\b/.test(sql) ||
              /WHERE m\.message_id=\$1/.test(sql)
            )
              return {
                rows: [
                  {
                    id: original.id,
                    guildId: config.guildId,
                    channelId: config.channelId,
                    at: "2026-01-01T00:00:00.000000Z",
                  },
                ],
                rowCount: 1,
              };
            if (/FROM messages m WHERE m\.deleted_at IS NULL AND m\.content IS NOT NULL/.test(sql))
              return {
                rows: [{ id: original.id, guildId: config.guildId, channelId: config.channelId }],
                rowCount: 1,
              };
            return { rows: [], rowCount: 0 };
          },
        };
        const botConfig = { ...config, botId: "444444444444444444" };
        const read = archiveTool(store, discord, botConfig, archive);
        const queue = historyQueue(store, {}, config, directory, async () => {}, null);

        await hold();
        await assert.rejects(read({ messageId: preBoot.id }), /recovery/i);
        assert.deepEqual(calls, [], "held must refuse before any archive query");

        await recovery.releaseRecovery(db, {
          expectedRevision: 1,
          reason: "Fictional archive read release",
          frontiers: { [config.channelId]: frontier },
          confirmLiveOnly: true,
        });
        const before = await snapshot();

        // (a) The archive read path succeeds under live-only.
        const result = await read({ messageId: preBoot.id });
        assert.deepEqual(
          result.sources.map((source) => source.id),
          [preBoot.id],
        );
        assert.equal(result.recovery.phase, "live-only");
        assert.equal(result.recovery.persisted, false);
        assert(calls.length > 0, "the read must actually reach the archive");

        // The discussions proxy passes the same permitted read-only kind.
        const discussions = archiveDiscussions(store, discord, botConfig, archive);
        const discussion = await discussions.readDiscussion({ anchorId: preBoot.id });
        assert.equal(discussion.anchorId, preBoot.id);
        assert.deepEqual(
          discussion.sources.map((source) => source.id),
          [preBoot.id],
        );
        assert.equal(discussion.recovery.persisted, false);

        // Only the read-only kind widened: every intake/mutation kind stays denied.
        for (const kind of ["history", "operator", "reset", "migrate", "edit", "remove"])
          await assert.rejects(store.recovery(kind), /recovery/i);
        assert.equal(
          (await store.recovery("archive")).phase,
          "live-only",
          "archive must be the one kind live-only permits",
        );

        // The archive-safe source reads one exact original on a released route,
        // refuses protected ids, and never exposes paging or write callbacks.
        let reads = 0;
        const safe = recovery.recoveryArchiveSource(
          db,
          new Proxy(
            {},
            {
              get: (_target, key) =>
                key === "serverTime"
                  ? () => 1
                  : async () => {
                      reads++;
                      return { id: preBoot.id };
                    },
            },
          ),
        );
        assert.equal(typeof safe.get, "function");
        // Source `a` is protected by this hold, so archive recall refuses it.
        await assert.rejects(safe.get(config.channelId, a), /archive recall/i);
        // Another released route is not a released id: the frontier route list is
        // explicit, so an unlisted channel is refused too.
        await assert.rejects(safe.get("222222222222222223", preBoot.id), /archive recall/i);
        assert.equal((await safe.get(config.channelId, preBoot.id)).id, preBoot.id);
        assert.equal(reads, 1);
        for (const key of ["recent", "around", "after", "send", "react", "typing", "me"])
          assert.equal(safe[key], undefined, `${key} must not be reachable from archive recall`);

        // (b) Derivation stays disabled and no pre-boot row becomes work: the
        // queue refuses before any archive read, and the ordinary work selector
        // filters the pre-frontier sources out.
        assert.equal(
          recovery.historyDerivationDisposition(await recovery.readRecoveryPolicy(db)),
          "recovery-disabled",
        );
        const beforeQueue = calls.length;
        await assert.rejects(queue.next(), /recovery/i);
        assert.equal(calls.length, beforeQueue, "derivation must not reach the archive");
        assert.equal(await store.next(), null);
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int n FROM pilot_work WHERE history_episode IS NOT NULL",
            )
          ).rows[0].n,
          0,
        );

        // Reads persisted nothing: no archive original was enrolled or invalidated,
        // so a live reply cannot cite it as memory evidence either. The pilot row
        // still holds the fixture text, not the archive-only content.
        assert.deepEqual(await snapshot(), before);
        assert.equal(
          (
            await db.query("SELECT source->>'content' AS content FROM pilot_sources WHERE id=$1", [
              preBoot.id,
            ])
          ).rows[0].content,
          "Fictional recovery fixture",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
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
      // The live message itself is post-frontier and legitimate. Its parent is a
      // protected, pre-frontier original, so the lookup yields no parent context
      // instead of aborting: nothing is read and the transport callback never runs.
      assert.equal(
        await store.isAddressed(current, "444444444444444444", async () => {
          callbacks++;
          return null;
        }),
        false,
      );
      assert.equal(callbacks, 0);
    }),
);

test(
  "live-only exempts an unprotected pre-frontier original from the per-id transport gate only",
  database,
  () =>
    fixture("archive_recall_transport", async ({ db, hold }) => {
      await hold();
      const calls = [];
      const transport = recovery.recoveryTransport(
        db,
        new Proxy(
          {},
          {
            get:
              (target, key) =>
              async (...args) => {
                calls.push([key, ...args.slice(0, 2)]);
                return [];
              },
          },
        ),
      );
      // Pre-frontier and unprotected: the exact original an archive recall quotes.
      const recalled = "555555555555555400";
      // Released route, unprotected, above the frontier: ordinary live behavior.
      const live = "555555555555555551";
      // The exemption narrows only the per-id check; the overall live gate still
      // refuses first, so a held policy permits nothing even for this id.
      await assert.rejects(transport.get(config.channelId, recalled), /recovery/i);
      await assert.rejects(
        transport.send(config.channelId, { message_reference: { message_id: recalled } }),
        /recovery/i,
      );
      assert.deepEqual(calls, []);
      await recovery.releaseRecovery(db, {
        expectedRevision: 1,
        reason: "Fictional archive recall transport review",
        frontiers: { [config.channelId]: frontier },
        confirmLiveOnly: true,
      });
      assert.ok(
        recovery.archiveRecallReadAllowed(
          await recovery.readRecoveryPolicy(db),
          config.channelId,
          recalled,
        ),
      );
      assert.ok(BigInt(recalled) < BigInt(frontier));
      await transport.get(config.channelId, recalled);
      await transport.react(config.channelId, recalled, "fixture");
      await transport.send(config.channelId, { message_reference: { message_id: recalled } });
      await transport.get(config.channelId, live);
      await transport.send(config.channelId, { message_reference: { message_id: live } });
      assert.deepEqual(calls, [
        ["get", config.channelId, recalled],
        ["react", config.channelId, recalled],
        ["send", config.channelId, { message_reference: { message_id: recalled } }],
        ["get", config.channelId, live],
        ["send", config.channelId, { message_reference: { message_id: live } }],
      ]);
      // The exemption is per-id and narrow. A protected pre-frontier original is
      // still refused on every one of the three calls, as before the change.
      for (const fn of [
        () => transport.get(config.channelId, a),
        () => transport.react(config.channelId, a, "fixture"),
        () => transport.send(config.channelId, { message_reference: { message_id: a } }),
        // A released-route read of an id on an unreleased route is still refused.
        () => transport.get("222222222222222223", recalled),
        () => transport.send("222222222222222223", { message_reference: { message_id: recalled } }),
        // A send with no reply reference keeps its pre-existing refusal.
        () => transport.send(config.channelId, { content: "Fictional unreferenced reply" }),
        () => transport.get(config.channelId, "not-a-snowflake"),
      ])
        await assert.rejects(fn, /recovery/i);
      assert.equal(calls.length, 5);
    }),
);

test(
  "live-only ingests a post-frontier reply to a pre-frontier parent without reading or keeping that parent",
  database,
  () =>
    fixture("prefrontier_parent", async ({ db, store, hold, snapshot }) => {
      await hold();
      await recovery.releaseRecovery(db, {
        expectedRevision: 1,
        reason: "Fictional pre-frontier parent review",
        frontiers: { [config.channelId]: frontier },
        confirmLiveOnly: true,
      });
      // An unseeded id strictly below the released frontier: the shape of the
      // reply parent in the #economics-markets exchange that aborted the poll.
      const parent = "555555555555555400";
      const reply = { ...value("555555555555555551", "Fictional live reply"), replyTo: parent };
      const before = await snapshot();
      assert.equal(
        (await db.query("SELECT count(*)::int n FROM pilot_sources WHERE id=$1", [parent])).rows[0]
          .n,
        0,
      );
      // The transport would refuse this exact read. Record whether it is even asked:
      // the policy decides first, so a pre-frontier parent is never fetched.
      const reads = [];
      const readParent = async (channelId, id) => {
        reads.push([channelId, id]);
        return { id, channel_id: channelId, author: { id: "444444444444444444" } };
      };
      assert.equal(await store.isAddressed(reply, "444444444444444444", readParent), false);
      assert.deepEqual(reads, []);
      // The live message itself is still ingested as ordinary pending work.
      await store.ingest(reply, false);
      assert.equal(
        (await db.query("SELECT source->>'replyTo' p FROM pilot_sources WHERE id=$1", [reply.id]))
          .rows[0].p,
        parent,
      );
      // The pre-frontier parent was never read, so it never entered pilot state and
      // derived no work. Only the live reply row was added.
      assert.equal(
        (await db.query("SELECT count(*)::int n FROM pilot_sources WHERE id=$1", [parent])).rows[0]
          .n,
        0,
      );
      assert.equal(
        (
          await db.query("SELECT count(*)::int n FROM pilot_work WHERE source_ids && $1::text[]", [
            [parent],
          ])
        ).rows[0].n,
        0,
      );
      const after = await snapshot();
      assert.equal(after.pilot_sources.length, before.pilot_sources.length + 1);
      // The gate on the message itself, and the policy revision, are unchanged.
      assert.equal(
        (await db.query("SELECT policy FROM pilot_recovery_policy")).rows[0].policy.phase,
        "live-only",
      );
      assert.equal(
        (await db.query("SELECT policy FROM pilot_recovery_policy")).rows[0].policy.revision,
        2,
      );
      await assert.rejects(store.ingest(value(parent, "Fictional parent intake")), /recovery/i);
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

test("live-only commits a reply that cites pre-frontier memory evidence", database, () =>
  fixture("prefrontier_citation", async ({ db, store, hold }) => {
    await hold();
    await recovery.releaseRecovery(db, {
      expectedRevision: 1,
      reason: "Fictional pre-frontier citation review",
      frontiers: { [config.channelId]: frontier },
      confirmLiveOnly: true,
    });
    // A live message inside the frontier, answered by a turn whose memory entry
    // cites an older message strictly below it. This is the shape of every
    // production reply: all live memory entries cite pre-frontier evidence.
    const live = value("555555555555555600", "Fictional live question about fiction");
    // The citation already exists as historical evidence in the real system.
    // Seed it as pre-existing state, which is what production has.
    const citation = "555555555555555100";
    await seedHistorical(db, citation, "Fictional historical evidence");
    await store.ingest(live, true);
    const batch = await store.next();
    assert.equal(batch.replyTo, live.id);
    const memory = {
      read: async () => ({ revision: digest("prior") }),
      write: async () => {},
    };
    // The citation travels as validation evidence, exactly as usedSourceIds does.
    const id = await store.prepare(
      0,
      batch,
      { content: "Fictional new memory", expectedRevision: digest("prior") },
      "Fictional reply citing older evidence",
      [citation],
    );
    assert.deepEqual((await store.finish(memory)).completed, [id]);
    assert.equal(
      (await db.query("SELECT status FROM pilot_work WHERE id=$1", [id])).rows[0].status,
      "done",
    );
    // The citation was never enrolled as work and stays out of source_ids.
    assert.equal(
      (
        await db.query("SELECT count(*)::int n FROM pilot_work WHERE source_ids && $1::text[]", [
          [citation],
        ])
      ).rows[0].n,
      0,
    );
    // The frontier still governs what is actually replied to.
    await assert.rejects(store.ingest(value(citation, "Fictional intake")), /recovery/i);
  }),
);

test("live-only still refuses work whose own source is outside the frontier", database, () =>
  fixture("prefrontier_source_ids", async ({ db, store, hold }) => {
    await hold();
    await recovery.releaseRecovery(db, {
      expectedRevision: 1,
      reason: "Fictional outside-frontier source review",
      frontiers: { [config.channelId]: frontier },
      confirmLiveOnly: true,
    });
    // source_ids is still gated: a prepared work row naming a source that the
    // frontier does not admit must not commit. Relaxing citations must not
    // relax enrolment.
    const outside = "555555555555555120";
    await seedHistorical(db, outside, "Fictional out-of-frontier source");
    await assert.rejects(
      db.query(
        "INSERT INTO pilot_work(id,epoch,source_ids,candidate,status) VALUES('fictional-outside',0,$1,$2,'prepared')",
        [[outside], { content: "fictional candidate", expectedRevision: digest("prior") }],
      ),
      /recovery/i,
    );
  }),
);

// The archive-recall exemption is a narrow read path, not a widening of the gate. It
// applies only to an exact, unprotected original on a route that has a released
// frontier while the policy is live-only. Every other shape keeps the pre-existing
// refusal, and page reads stay closed regardless of the exemption.
function stubPolicyDb(stored) {
  return {
    async query(sql) {
      if (/to_regclass/.test(sql))
        return { rows: [{ name: stored ? "pilot_recovery_policy" : null }] };
      if (/FROM pilot_recovery_policy/.test(sql)) return { rows: [{ policy: stored }] };
      if (/FROM pg_locks/.test(sql)) return { rows: [{ owned: true }] };
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
      throw new Error(`Unexpected recovery query: ${sql}`);
    },
  };
}

test("the archive-recall exemption never widens the live gate", async () => {
  assert.ok(recovery, "pilot-recovery.mjs must exist for the transport preflight");
  const channel = config.channelId;
  const unreleased = "222222222222222299";
  const original = "555555555555555001"; // Pre-frontier, unprotected: the recall target.
  const liveOnly = {
    version: 1,
    phase: "live-only",
    revision: 2,
    baseline: "a".repeat(64),
    protectedSourceIds: [a],
    frontiers: { [channel]: frontier },
    reason: "Fictional live-only qualification",
  };
  const heldPolicy = { ...liveOnly, phase: "held", revision: 3 };

  // The predicate alone decides the exemption, so each refusal must be false here.
  assert.equal(recovery.archiveRecallReadAllowed(liveOnly, channel, original), true);
  assert.equal(recovery.archiveRecallReadAllowed(liveOnly, channel, a), false);
  assert.equal(recovery.archiveRecallReadAllowed(liveOnly, unreleased, original), false);
  assert.equal(recovery.archiveRecallReadAllowed(heldPolicy, channel, original), false);
  assert.equal(recovery.archiveRecallReadAllowed(liveOnly, channel, undefined), false);
  assert.equal(recovery.archiveRecallReadAllowed(null, channel, original), false);

  const guarded = (stored) => {
    const calls = [];
    const note =
      (key) =>
      async (...args) => {
        calls.push([key, ...args]);
        return key === "recent" || key === "after" || key === "around" ? [] : { id: args[1] };
      };
    return {
      calls,
      transport: recovery.recoveryTransport(stubPolicyDb(stored), {
        get: note("get"),
        recent: note("recent"),
        around: note("around"),
        after: note("after"),
        react: note("react"),
        send: note("send"),
        typing: note("typing"),
        channel: note("channel"),
      }),
    };
  };

  // Three shapes the exemption must not reach: each still refuses at the gate and
  // never invokes the transport callback.
  for (const [label, stored, args, refusal] of [
    [
      "a protected original",
      liveOnly,
      [channel, a],
      /protected or outside a released live frontier/,
    ],
    [
      "an original on a route with no released frontier",
      liveOnly,
      [unreleased, original],
      /protected or outside a released live frontier/,
    ],
    ["a non-live-only phase", heldPolicy, [channel, original], /held; no runtime side effects/],
  ]) {
    const subject = guarded(stored);
    await assert.rejects(() => subject.transport.get(...args), refusal, label);
    assert.deepEqual(subject.calls, [], `${label} must not reach the transport`);
  }

  // The permitted shape: an exact original below the frontier, unprotected.
  const permitted = guarded(liveOnly);
  assert.deepEqual(await permitted.transport.get(channel, original), { id: original });
  assert.deepEqual(permitted.calls, [["get", channel, original]]);

  // A reply carries its parent through message_reference; only an exact permitted
  // reference is exempt, so an unreferenced or protected send still refuses.
  const reply = { message_reference: { message_id: original } };
  const replying = guarded(liveOnly);
  await replying.transport.send(channel, reply);
  assert.deepEqual(replying.calls, [["send", channel, reply]]);
  const unreferenced = guarded(liveOnly);
  await assert.rejects(() => unreferenced.transport.send(channel, {}), /Recovery gate/);
  assert.deepEqual(unreferenced.calls, []);
  const protectedReply = guarded(liveOnly);
  await assert.rejects(
    () => protectedReply.transport.send(channel, { message_reference: { message_id: a } }),
    /protected or outside a released live frontier/,
  );
  assert.deepEqual(protectedReply.calls, []);

  // Page reads are untouched: the exemption never opens a historical window.
  for (const [key, args, refusal] of [
    ["recent", [channel], /historical\/default-page reads disabled/],
    ["around", [channel], /historical\/default-page reads disabled/],
    ["after", [channel, original], /route\/frontier not released/],
  ]) {
    const subject = guarded(liveOnly);
    await assert.rejects(() => subject.transport[key](...args), refusal);
    assert.deepEqual(subject.calls, []);
  }

  // No policy is ordinary mode, which the gate leaves alone.
  const ordinary = guarded(null);
  await ordinary.transport.get(channel, a);
  assert.deepEqual(ordinary.calls, [["get", channel, a]]);
});
