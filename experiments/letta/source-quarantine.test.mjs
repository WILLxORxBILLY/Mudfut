import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import pg from "pg";
import { pilotStore, sourceRecord, deliver, digest } from "./pilot-store.mjs";
import { holdRecovery, releaseRecovery } from "./pilot-recovery.mjs";
import { deferGeneration } from "./pilot-generation-failures.mjs";

const exec = promisify(execFile);
const bin = (name) =>
  process.env.MUDFUT_PG_BIN ? join(resolve(process.env.MUDFUT_PG_BIN), name) : name;
let skip = false;
try {
  assert.match((await exec(bin("initdb"), ["--version"])).stdout, /\b16\./);
} catch (error) {
  if (process.env.MUDFUT_PG_BIN) throw error;
  skip = "PostgreSQL 16 unavailable; set MUDFUT_PG_BIN to run source quarantine integration";
}
const check = (name, run) => test(name, { skip }, run);
const config = { guildId: "111111111111111111", channelId: "222222222222222222" };
const old = "555555555555555499",
  a = "555555555555555501",
  b = "555555555555555502",
  c = "555555555555555503",
  protectedId = "555555555555555550";
const source = (id, content = `Fictional source ${id}`) =>
  sourceRecord(
    {
      id,
      channel_id: config.channelId,
      content,
      author: { id: "333333333333333333", username: "Fictional member" },
      timestamp: "2026-01-01T00:00:00.000Z",
      type: 0,
    },
    config.guildId,
    config.channelId,
  );
let root,
  data,
  settings,
  sequence = 0;

test.before(async () => {
  if (skip) return;
  root = await mkdtemp(join(tmpdir(), "mudfut-source-quarantine-"));
  data = join(root, "data");
  const probe = createServer();
  await new Promise((accept, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", accept);
  });
  const port = probe.address().port;
  await new Promise((accept) => probe.close(accept));
  await exec(bin("initdb"), [
    "-D",
    data,
    "-U",
    "mudfut_fixture",
    "--auth=trust",
    "--encoding=UTF8",
    "--no-locale",
  ]);
  await exec(bin("pg_ctl"), [
    "-D",
    data,
    "-l",
    join(root, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ''`,
    "-w",
    "start",
  ]);
  settings = {
    host: "127.0.0.1",
    port,
    user: "mudfut_fixture",
    database: "postgres",
    statement_timeout: 5000,
  };
});
test.after(async () => {
  if (!root) return;
  if (data) await exec(bin("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  const trash = join(homedir(), ".Trash");
  await mkdir(trash, { recursive: true, mode: 0o700 });
  const destination = join(trash, basename(root));
  await rename(root, destination);
  console.log(`Preserved fictional quarantine fixture in Trash: ${destination}`);
});

async function fixture(run, liveOnly = false, beforePolicy = async () => {}) {
  const db = new pg.Client(settings);
  await db.connect();
  const schema = `source_quarantine_${++sequence}`;
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    const store = await pilotStore(db, config);
    for (const id of [old, a, b, c, protectedId]) await store.ingest(source(id), true);
    await beforePolicy({ db, store });
    if (liveOnly) {
      await holdRecovery(db, {
        baseline: "a".repeat(64),
        protectedSourceIds: [protectedId],
        reason: "Fictional reset safety",
      });
      await releaseRecovery(db, {
        expectedRevision: 1,
        reason: "Fictional released live route",
        confirmLiveOnly: true,
        frontiers: { [config.channelId]: "555555555555555500" },
      });
    }
    const snapshot = async () => ({
      sources: (await db.query("SELECT * FROM pilot_sources ORDER BY id")).rows,
      meta: (await db.query("SELECT * FROM pilot_meta")).rows,
    });
    await run({ db, store, snapshot, schema });
  } finally {
    await db.end();
  }
}

for (const liveOnly of [false, true])
  for (const reason of ["deleted", "edited"]) {
    check(
      `${liveOnly ? "live-only" : "normal"}: ${reason} quarantine preserves original rows and global state`,
      () =>
        fixture(async ({ db, store, snapshot }) => {
          const before = await snapshot();
          const row = (await store.validationSources([a]))[0];
          const result = await store.quarantineSource(row, reason);
          assert.equal(result.held, true);
          assert.equal(result.inserted, true);
          assert.equal(result.reason, `source-unavailable:${reason}`);
          assert.deepEqual(await snapshot(), before);
          assert.equal((await store.findSources([a])).length, 0);
          assert.equal(
            (await store.eligible()).some((row) => row.id === a),
            false,
          );
          assert.equal(
            (await store.validationSources()).some((row) => row.id === a),
            false,
          );
          assert.equal(
            (await store.next()).rows.some((row) => row.id === a),
            false,
          );
          assert.equal(
            (await store.context(c)).priorMessages.some((item) => item.id === a),
            false,
          );
          const hold = (await db.query("SELECT * FROM pilot_source_holds WHERE source_id=$1", [a]))
            .rows;
          await store.quarantineSource(row, reason === "deleted" ? "edited" : "deleted");
          assert.deepEqual(
            (await db.query("SELECT * FROM pilot_source_holds WHERE source_id=$1", [a])).rows,
            hold,
          );
          assert.deepEqual(await snapshot(), before);
        }, liveOnly),
    );
  }

check(
  "protected, pre-frontier, foreign-route and stale snapshots cannot acquire live-only holds",
  () =>
    fixture(async ({ db, store, snapshot }) => {
      const before = await snapshot();
      for (const id of [old, protectedId])
        await assert.rejects(() => store.quarantineSource(source(id), "deleted"), /Recovery gate/);
      await assert.rejects(
        () => store.quarantineSource({ ...source(a), channelId: "222222222222222999" }, "deleted"),
        { code: "SOURCE_SNAPSHOT_CHANGED" },
      );
      const row = (await store.validationSources([a]))[0];
      await assert.rejects(
        () => store.quarantineSource({ ...row, hash: "stale hash" }, "deleted"),
        { code: "SOURCE_SNAPSHOT_CHANGED" },
      );
      await assert.rejects(() => store.quarantineSource(source(a, "Changed snapshot"), "edited"), {
        code: "SOURCE_SNAPSHOT_CHANGED",
      });
      await assert.rejects(
        () => store.quarantineSource(source(a), "other"),
        /Invalid source quarantine/,
      );
      assert.equal((await db.query("SELECT * FROM pilot_source_holds")).rowCount, 0);
      assert.deepEqual(await snapshot(), before);
    }, true),
);

check("quarantine requires ownership and another worker cannot claim the store", () =>
  fixture(async ({ db, store, snapshot, schema }) => {
    const other = new pg.Client(settings);
    await other.connect();
    try {
      await other.query(`SET search_path TO ${schema}`);
      await assert.rejects(() => pilotStore(other, config), /Another pilot worker/);
      const before = await snapshot();
      await db.query("SELECT pg_advisory_unlock(1560387,1127029)");
      await assert.rejects(() => store.quarantineSource(source(a), "deleted"), {
        code: "PILOT_OWNERSHIP_REQUIRED",
      });
      assert.deepEqual(await snapshot(), before);
    } finally {
      await other.end();
    }
  }, false),
);

check("held recovery rejects quarantine without changing preserved rows", () =>
  fixture(async ({ db, store, snapshot }) => {
    await holdRecovery(db, {
      baseline: "b".repeat(64),
      protectedSourceIds: [protectedId],
      reason: "Fictional full stop",
    });
    const before = await snapshot();
    await assert.rejects(() => store.quarantineSource(source(a), "deleted"), /Recovery gate/);
    assert.deepEqual(await snapshot(), before);
  }),
);

check("prepare rejects held target, evidence and context with a typed error", () =>
  fixture(async ({ store, db }) => {
    await store.quarantineSource((await store.validationSources([a]))[0], "deleted");
    const row = (await store.validationSources([b]))[0];
    const candidate = {
      content: "Fictional preserved candidate",
      expectedRevision: digest("prior"),
    };
    for (const batch of [
      { rows: [{ id: a, source: source(a) }], replyTo: a },
      { rows: [row], replyTo: b },
      { rows: [row], replyTo: b, context: { priorMessages: [source(a)] } },
    ])
      await assert.rejects(
        () => store.prepare(0, batch, candidate, "Fictional reply", batch.context ? [] : [a]),
        { code: "SOURCE_QUARANTINED" },
      );
    assert.equal((await db.query("SELECT * FROM pilot_work")).rowCount, 0);
    assert.ok(
      await store.prepare(0, { rows: [row], replyTo: b }, candidate, "Allowed unrelated reply", [
        b,
      ]),
    );
  }, true),
);

check("held prepared and ready/sending dependent replies preserve receipts and never send", () =>
  fixture(async ({ store, db, snapshot }) => {
    for (const [id, status] of [
      [b, "ready"],
      [c, "sending"],
      [protectedId, "sent"],
    ]) {
      await db.query(
        "INSERT INTO pilot_work(id,epoch,source_ids,validation_ids,candidate,reply_to,reply,status) VALUES($1,0,$2,$3,$4,$5,$6,$7)",
        [
          `work-${id}`,
          [id],
          [a],
          { content: "Fictional candidate", expectedRevision: digest("prior") },
          id,
          "Fictional preserved reply",
          id === protectedId ? "done" : "prepared",
        ],
      );
      await db.query(
        "INSERT INTO pilot_outbox(source_id,content,epoch,status,discord_id) VALUES($1,$2,0,$3,$4)",
        [id, "Fictional preserved reply", status, status === "sent" ? "666666666666666666" : null],
      );
    }
    const before = await snapshot();
    const terminal = (
      await db.query("SELECT * FROM pilot_outbox WHERE source_id=$1", [protectedId])
    ).rows;
    const work = (await db.query("SELECT * FROM pilot_work ORDER BY id")).rows;
    await store.quarantineSource((await store.validationSources([a]))[0], "edited");
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await db.query("SELECT * FROM pilot_work ORDER BY id")).rows, work);
    assert.deepEqual(
      (await db.query("SELECT * FROM pilot_outbox WHERE source_id=$1", [protectedId])).rows,
      terminal,
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT status FROM pilot_outbox WHERE source_id=ANY($1::text[]) ORDER BY source_id",
          [[b, c]],
        )
      ).rows,
      [{ status: "held" }, { status: "held" }],
    );
    let callbacks = 0;
    const finished = await store.finish({
      read: async () => {
        callbacks++;
      },
      write: async () => {
        callbacks++;
      },
    });
    assert.equal(callbacks, 0);
    assert.equal(finished.deferred.length, 2);
    await deliver(
      store,
      { send: async () => assert.fail("Quarantined reply sent") },
      "444444444444444444",
      config.channelId,
      async () => {},
    );
  }),
);

check("delivery also blocks held citation evidence without a propagated target hold", () =>
  fixture(async ({ store, db }) => {
    await db.query(
      "INSERT INTO pilot_work(id,epoch,source_ids,validation_ids,candidate,reply_to,reply,status) VALUES('work',0,$1,$2,$3,$4,'Fictional reply','done')",
      [[b], [a], { content: "Fictional candidate" }, b],
    );
    await db.query(
      "INSERT INTO pilot_outbox(source_id,content,epoch) VALUES($1,'Fictional reply',0)",
      [b],
    );
    await db.query(
      "INSERT INTO pilot_source_holds(source_id,reason) VALUES($1,'Fictional existing operator hold')",
      [a],
    );
    await deliver(
      store,
      { send: async () => assert.fail("Held citation reply sent") },
      "444444444444444444",
      config.channelId,
      async () => {},
    );
    assert.equal(
      (await db.query("SELECT status FROM pilot_outbox WHERE source_id=$1", [b])).rows[0].status,
      "held",
    );
  }),
);

for (const liveOnly of [false, true])
  check(
    `${liveOnly ? "live-only" : "normal"}: incomplete turns record guarded source-local retries without global edits`,
    () =>
      fixture(async ({ db, store, snapshot }) => {
        const row = (await store.validationSources([a]))[0];
        const batch = { rows: [row], replyTo: a };
        const before = await snapshot();
        const policy = liveOnly
          ? (await db.query("SELECT policy FROM pilot_recovery_policy")).rows
          : null;
        const first = await deferGeneration(store, batch);
        assert.equal(first.length, 1);
        assert.equal(first[0].source_id, a);
        assert.equal(first[0].failure_count, 1);
        assert.equal(
          Number(
            (
              await db.query(
                "SELECT extract(epoch FROM next_attempt_at-last_failed_at) AS seconds FROM pilot_generation_failures WHERE source_id=$1",
                [a],
              )
            ).rows[0].seconds,
          ),
          30,
        );
        assert.notEqual((await store.next()).replyTo, a);
        if (liveOnly) assert.equal((await store.next()).replyTo, b);
        const resumed = await pilotStore(db, config);
        assert.notEqual((await resumed.next()).replyTo, a);
        for (let attempt = 2; attempt <= 3; attempt++) {
          await db.query(
            "UPDATE pilot_generation_failures SET next_attempt_at=now()-interval '1 second' WHERE source_id=$1",
            [a],
          );
          const receipts = await deferGeneration(store, batch);
          assert.equal(receipts[0].failure_count, attempt);
          assert.equal(
            Number(
              (
                await db.query(
                  "SELECT extract(epoch FROM next_attempt_at-last_failed_at) AS seconds FROM pilot_generation_failures WHERE source_id=$1",
                  [a],
                )
              ).rows[0].seconds,
            ),
            120,
          );
        }
        await db.query(
          "UPDATE pilot_generation_failures SET next_attempt_at=now()-interval '1 second' WHERE source_id=$1",
          [a],
        );
        assert.notEqual(
          (await store.next()).replyTo,
          a,
          "Three failures isolate only that source after backoff expires",
        );
        assert.deepEqual(await snapshot(), before);
        if (liveOnly) {
          assert.deepEqual(
            (await db.query("SELECT policy FROM pilot_recovery_policy")).rows,
            policy,
          );
          let callback = false;
          await assert.rejects(
            () =>
              store.transaction(() => {
                callback = true;
              }),
            /edit remains disabled/,
          );
          assert.equal(callback, false);
        }
        assert.equal((await db.query("SELECT * FROM pilot_work")).rowCount, 0);
        assert.equal((await db.query("SELECT * FROM pilot_outbox")).rowCount, 0);
      }, liveOnly),
  );

check(
  "generation retry receipts reject protected, old and actual foreign-route targets atomically",
  () =>
    fixture(
      async ({ db, store, snapshot }) => {
        const before = await snapshot();
        const actual = async (id) =>
          (await db.query("SELECT * FROM pilot_sources WHERE id=$1", [id])).rows[0];
        for (const id of [old, protectedId])
          await assert.rejects(
            () => actual(id).then((row) => deferGeneration(store, { rows: [row], replyTo: id })),
            /Recovery gate/,
          );
        const valid = await actual(a);
        for (const id of ["555555555555555560", "555555555555555561"]) {
          const foreign = await actual(id);
          await assert.rejects(() => deferGeneration(store, { rows: [foreign], replyTo: id }), {
            code: "GENERATION_FAILURE_TARGET_INVALID",
          });
          await assert.rejects(
            () => deferGeneration(store, { rows: [valid, foreign], replyTo: null }),
            { code: "GENERATION_FAILURE_TARGET_INVALID" },
          );
        }
        assert.equal((await db.query("SELECT * FROM pilot_generation_failures")).rowCount, 0);
        assert.deepEqual(await snapshot(), before);
      },
      true,
      async ({ store }) => {
        await store.ingest(
          { ...source("555555555555555560"), guildId: "111111111111111999" },
          true,
        );
        await store.ingest(
          { ...source("555555555555555561"), channelId: "222222222222222999" },
          true,
        );
      },
    ),
);

check("generation retry recording skips stale hashes and held or completed sources", () =>
  fixture(async ({ db, store, snapshot }) => {
    const row = (await store.validationSources([a]))[0];
    const before = await snapshot();
    assert.deepEqual(
      await deferGeneration(store, { rows: [{ ...row, hash: "f".repeat(64) }], replyTo: a }),
      [],
    );
    assert.deepEqual(await snapshot(), before);
    await store.quarantineSource(row, "deleted");
    assert.deepEqual(await deferGeneration(store, { rows: [row], replyTo: a }), []);
    await db.query("UPDATE pilot_sources SET learned=true,addressed=false WHERE id=$1", [b]);
    const completed = (await store.validationSources([b]))[0];
    const after = await snapshot();
    assert.deepEqual(await deferGeneration(store, { rows: [completed], replyTo: null }), []);
    assert.deepEqual(await snapshot(), after);
    assert.equal((await db.query("SELECT * FROM pilot_generation_failures")).rowCount, 0);
  }, true),
);

check("generation retry API rejects forged source bodies and malformed batches before writes", () =>
  fixture(async ({ db, store, snapshot }) => {
    const row = (await store.validationSources([a]))[0];
    const before = await snapshot();
    await assert.rejects(
      () =>
        deferGeneration(store, {
          rows: [{ ...row, source: { ...row.source, channelId: "222222222222222999" } }],
          replyTo: a,
        }),
      { code: "GENERATION_FAILURE_TARGET_INVALID" },
    );
    for (const batch of [
      { rows: [], replyTo: null },
      { rows: "wrong", replyTo: null },
      { rows: [row, row], replyTo: null },
      { rows: [row], replyTo: b },
      { rows: [row], replyTo: a, historyEpisode: "history" },
      { rows: [row], replyTo: a, operatorRequest: { id: "operator" } },
      { rows: [{ ...row, hash: "not-a-hash" }], replyTo: a },
    ])
      await assert.rejects(
        () => deferGeneration(store, batch),
        /Invalid live generation failure targets/,
      );
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.query("SELECT * FROM pilot_generation_failures")).rowCount, 0);
    await db.query("SELECT pg_advisory_unlock(1560387,1127029)");
    await assert.rejects(() => deferGeneration(store, { rows: [row], replyTo: a }), /ownership/);
  }),
);
