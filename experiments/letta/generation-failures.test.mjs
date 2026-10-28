import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { state } from "./runtime.mjs";
import { pilotStore } from "./pilot-store.mjs";
import { turnInput } from "./pilot-reply.mjs";
import {
  requireObservationDecisions,
  incompleteLiveTurn,
  deferGeneration,
  generationFailureStatus,
} from "./pilot-generation-failures.mjs";

const guildId = "111111111111111111",
  channelId = "222222222222222222";
const source = (id, content = "A fictional observation") => ({
  id: String(555555555555555500n + BigInt(id)),
  guildId,
  channelId,
  authorId: "333333333333333333",
  content,
  createdAt: "2026-02-01T00:00:00Z",
});

test("only incomplete live model output can be deferred before candidate preparation", () => {
  requireObservationDecisions(true);
  let failure;
  try {
    requireObservationDecisions(false);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "MODEL_OBSERVATIONS_INCOMPLETE");
  const context = {
    batch: { rows: [{ id: source(1).id }] },
    phase: "model",
    stopping: false,
    connectionFailure: null,
  };
  assert(incompleteLiveTurn(failure, context));
  for (const phase of ["prepare", "memory_commit", "delivery", "history_validation"])
    assert.equal(incompleteLiveTurn(failure, { ...context, phase }), false);
  for (const change of [
    { stopping: true },
    { connectionFailure: new Error("database disconnected") },
    { batch: { rows: [] } },
    { batch: { ...context.batch, historyEpisode: "episode" } },
    { batch: { ...context.batch, operatorRequest: { id: "request" } } },
  ])
    assert.equal(incompleteLiveTurn(failure, { ...context, ...change }), false);
  for (const error of [
    new Error("database timeout"),
    { status: 401 },
    { code: "ENOSPC" },
    { code: "HISTORY_PREEMPTED" },
  ])
    assert.equal(incompleteLiveTurn(error, context), false);
  const input = turnInput(
    {
      rows: [{ id: source(1).id, source: source(1), generation_failures: 1 }],
      replyTo: source(1).id,
    },
    "revision",
    "444444444444444444",
  );
  assert.match(input.memoryContract.repairInstruction, /committed nothing/);
  assert.deepEqual(input.memoryContract.observationTargetIds, [source(1).id]);
});

test(
  "durable per-source retry budget isolates poison turns across restarts without fabricating learning",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () => {
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const admin = new pg.Client(credentials);
    await admin.connect();
    const name = "mudfut_generation_" + randomUUID().replaceAll("-", "");
    let db;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      const connect = async () => {
        db = new pg.Client({ ...credentials, database: name });
        await db.connect();
        return pilotStore(db, { guildId, channelId });
      };
      let store = await connect();
      await store.ingest(source(1), true);
      await store.ingest(source(2), true);
      await store.ingest(source(3), false);
      const bad = await store.next();
      assert.equal(bad.replyTo, source(1).id);
      const failure = await deferGeneration(store, bad);
      assert.equal(failure[0].failure_count, 1);
      assert.equal(
        (await store.next()).replyTo,
        source(2).id,
        "bad oldest message must not block healthy direct work",
      );
      await db.end();
      store = await connect();
      assert.equal(
        (await store.next()).replyTo,
        source(2).id,
        "restarting cannot reset the failed turn's backoff",
      );
      for (let attempt = 2; attempt <= 3; attempt++) {
        await db.query(
          "UPDATE pilot_generation_failures SET next_attempt_at=now()-interval '1 second'",
        );
        const retry = await store.next();
        assert.equal(retry.replyTo, source(1).id);
        assert.equal(retry.rows[0].generation_failures, attempt - 1);
        assert.equal((await deferGeneration(store, retry))[0].failure_count, attempt);
      }
      await db.query(
        "UPDATE pilot_generation_failures SET next_attempt_at=now()-interval '1 second'",
      );
      assert.equal((await generationFailureStatus(db))[0].held, true);
      assert.equal(
        (await store.next()).replyTo,
        source(2).id,
        "exhausted turn stays held even after backoff expires",
      );
      assert.equal((await db.query("SELECT count(*)::int n FROM pilot_work")).rows[0].n, 0);
      assert.equal((await db.query("SELECT count(*)::int n FROM pilot_outbox")).rows[0].n, 0);
      assert.equal(
        (await db.query("SELECT learned FROM pilot_sources WHERE id=$1", [source(1).id])).rows[0]
          .learned,
        false,
      );
      await store.ingest(source(1, "A corrected fictional observation"), true);
      assert.equal((await store.next()).replyTo, source(1).id);
      assert.equal((await store.next()).rows[0].generation_failures, 0);
      assert.equal(
        (await generationFailureStatus(db)).length,
        0,
        "old revision failure is no longer active",
      );
      assert.equal(
        (await db.query("SELECT count(*)::int n FROM pilot_generation_failures")).rows[0].n,
        1,
        "old receipt is preserved",
      );
      await deferGeneration(store, bad);
      assert.equal(
        (await store.next()).rows[0].generation_failures,
        0,
        "stale failed work cannot penalize an edited source",
      );
      // Isolate ambient retries too; acknowledged direct rows remain preserved in this fixture.
      await db.query(
        "UPDATE pilot_sources SET learned=true,addressed=false WHERE id=ANY($1::text[])",
        [[source(1).id, source(2).id]],
      );
      const ambient = await store.next();
      assert.equal(ambient.replyTo, null);
      await deferGeneration(store, ambient);
      assert.equal(await store.next(), null);
      assert.equal(
        (await db.query("SELECT learned FROM pilot_sources WHERE id=$1", [source(3).id])).rows[0]
          .learned,
        false,
      );
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
