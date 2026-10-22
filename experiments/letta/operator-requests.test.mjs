import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { state } from "./runtime.mjs";
import { digest, pilotStore } from "./pilot-store.mjs";
import { encodeUnderstanding } from "./pilot-memory.mjs";
import {
  validateOperatorRequest,
  stageOperatorRequest,
  operatorRequests,
} from "./pilot-requests.mjs";

const request = (id = "example-one") => ({
  id,
  prompt: "What changed in the real discussion?",
  requestedAt: "2026-10-16T12:00:00.000Z",
  origin: "operator",
  delivery: "chat",
});

test("operator origin and empty-source contract cannot be replaced by forged Discord attributes", () => {
  assert.deepEqual(validateOperatorRequest({ ...request(), delivery: undefined }), request());
  for (const value of [
    { ...request(), origin: "discord" },
    { ...request(), authorId: "333333333333333333" },
    { ...request(), messageId: "555555555555555555" },
    { ...request(), delivery: "feeds" },
    { ...request(), id: "../../source" },
    { ...request(), prompt: " " },
    { ...request(), requestedAt: "2026-02-30T12:00:00.000Z" },
    { ...request(), requestedAt: "2026-10-16" },
  ])
    assert.throws(() => validateOperatorRequest(value));
});

test("request staging publishes complete immutable JSON and identical retries preserve the original", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mudfut-operator-stage-"));
  try {
    const first = await stageOperatorRequest(directory, request());
    const before = await stat(first.path);
    assert.equal(before.mode & 0o777, 0o600);
    await stageOperatorRequest(directory, request());
    assert.equal((await stat(first.path)).ino, before.ino);
    await assert.rejects(
      stageOperatorRequest(directory, { ...request(), prompt: "A different request" }),
      /different immutable/,
    );
    assert.deepEqual(JSON.parse(await readFile(first.path, "utf8")), request());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "operator queue resumes the same prepared candidate, receipts the normal memory commit and never creates delivery/source rows",
  {
    skip: process.env.CHECK_DATABASE !== "1",
  },
  async () => {
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const admin = new pg.Client(credentials);
    await admin.connect();
    const database = "mudfut_requests_check_" + randomUUID().replaceAll("-", "");
    const directory = await mkdtemp(join(tmpdir(), "mudfut-operator-db-"));
    let db;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      db = new pg.Client({ ...credentials, database });
      await db.connect();
      const store = await pilotStore(db, {
        guildId: "111111111111111111",
        channelId: "222222222222222222",
        historyScope: [],
      });
      const events = [];
      let queue = await operatorRequests(store, directory, async (event) => events.push(event));
      const index = (
        await db.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='pilot_work_operator_request_lookup'",
        )
      ).rows[0];
      assert.match(index.indexdef, /candidate.*operatorRequestId.*status.*created_at/i);
      await stageOperatorRequest(directory, request());
      const first = await queue.next();
      assert.deepEqual(first, { rows: [], replyTo: null, operatorRequest: request(), context: {} });
      const content = encodeUnderstanding([]);
      let current = { content, revision: digest(content) },
        commits = 0;
      const memory = {
        read: async () => current,
        write: async (input) => {
          commits++;
          current = { content: input.content, revision: digest(input.content) };
        },
      };
      const replyEvidence = [
        { kind: "retained_memory", keys: ["an-existing-key"], contextSources: [] },
      ];
      const workId = await store.prepare(
        0,
        first,
        {
          content,
          expectedRevision: current.revision,
          audit: [],
          operatorRequestId: request().id,
          replyEvidence,
        },
        "A sourced normal reply.",
        ["555555555555555555"],
      );
      queue = await operatorRequests(store, directory);
      assert.equal(
        await queue.next(),
        null,
        "Prepared candidate must resume rather than regenerate",
      );
      assert.equal(
        await queue.fail(request().id, new Error("Interrupted after prepare")),
        false,
        "An already prepared candidate remains recoverable",
      );
      await store.finish(memory);
      await queue.reconcile();
      assert.equal(commits, 1);
      const done = (await queue.status())[0];
      assert.equal(done.status, "done");
      assert.equal(done.work_id, workId);
      assert.equal(done.reply, "A sourced normal reply.");
      assert.deepEqual(done.validation_ids, ["555555555555555555"]);
      assert.deepEqual(
        done.reply_evidence,
        replyEvidence,
        "Evidence array must remain JSON rather than a PG array",
      );
      await queue.reconcile();
      assert.equal(await queue.next(), null);
      assert.equal(
        (await db.query("SELECT count(*)::integer AS count FROM pilot_work")).rows[0].count,
        1,
      );
      assert.equal(
        (await db.query("SELECT count(*)::integer AS count FROM pilot_sources")).rows[0].count,
        0,
      );
      assert.equal(
        (await db.query("SELECT count(*)::integer AS count FROM pilot_outbox")).rows[0].count,
        0,
      );

      await stageOperatorRequest(directory, request("example-two"));
      assert.equal((await queue.next()).operatorRequest.id, "example-two");
      await queue.fail("example-two", new Error("Original model failure"));
      queue = await operatorRequests(store, directory);
      assert.equal(
        await queue.next(),
        null,
        "Failed requests never retry automatically after restart",
      );
      const failed = (await queue.status()).find((row) => row.id === "example-two");
      assert.equal(failed.status, "failed");
      assert.equal(failed.error.message, "Original model failure");
      assert.equal(
        await queue.fail(request().id, new Error("Late error")),
        false,
        "A done receipt cannot become a failure",
      );
      const path = join(directory, "operator-requests", "example-one.json");
      await writeFile(path, JSON.stringify({ ...request(), prompt: "Mutated input" }));
      await stageOperatorRequest(directory, request("example-three"));
      await stageOperatorRequest(directory, request("example-four"));
      assert.ok(
        ["example-three", "example-four"].includes((await queue.next()).operatorRequest.id),
      );
      const malformed = Buffer.from('{"bad":');
      const invalidUtf8 = Buffer.from([0xff, 0x7b]);
      const brokenPath = join(directory, "operator-requests", "broken.json");
      const invalidPath = join(directory, "operator-requests", "invalid-utf8.json");
      await writeFile(brokenPath, malformed);
      await writeFile(invalidPath, invalidUtf8);
      await writeFile(join(directory, "operator-requests", "example-four.json"), malformed);
      assert.equal(
        (await queue.next()).operatorRequest.id,
        "example-three",
        "Invalid and changed files cannot block a valid request",
      );
      const quarantines = (await db.query("SELECT * FROM pilot_operator_admission_failures")).rows;
      assert.equal(quarantines.length, 4);
      assert.deepEqual(quarantines.find((row) => row.path === brokenPath).content_bytes, malformed);
      assert.deepEqual(
        quarantines.find((row) => row.path === invalidPath).content_bytes,
        invalidUtf8,
      );
      assert.equal(
        quarantines.find((row) => row.path === invalidPath).content_sha256,
        digest(invalidUtf8),
      );
      assert.equal(
        (await queue.status()).find((row) => row.id === "example-four").status,
        "failed",
      );
      await queue.next();
      assert.equal(
        (await db.query("SELECT count(*)::int AS count FROM pilot_operator_admission_failures"))
          .rows[0].count,
        4,
        "Repeated bad bytes are quarantined once",
      );
      await assert.rejects(
        db.query("DELETE FROM pilot_operator_admission_failures"),
        /append-only/,
      );
      const third = await queue.next();
      const preparedId = await store.prepare(
        0,
        third,
        {
          content,
          expectedRevision: current.revision,
          audit: [],
          operatorRequestId: "example-three",
        },
        "Prepared original request survived.",
        [],
      );
      await writeFile(
        join(directory, "operator-requests", "example-three.json"),
        JSON.stringify({ ...request("example-three"), prompt: "Changed after prepare" }),
      );
      assert.equal(await queue.next(), null);
      assert.equal(
        (await queue.status()).find((row) => row.id === "example-three").status,
        "queued",
        "Quarantine cannot abandon prepared work",
      );
      await store.finish(memory);
      await queue.reconcile();
      assert.equal(
        (await queue.status()).find((row) => row.id === "example-three").work_id,
        preparedId,
      );
      assert.equal((await queue.status()).find((row) => row.id === "example-three").status, "done");
      await store.ingest(
        {
          id: "555555555555555599",
          guildId: "111111111111111111",
          channelId: "222222222222222222",
          authorId: "333333333333333333",
          content: "Actual fixture direct question",
          createdAt: "2026-10-16T12:00:00.000Z",
        },
        true,
      );
      assert.equal(
        (await store.next()).replyTo,
        "555555555555555599",
        "Live direct work remains available after operator quarantine",
      );
      assert.equal(
        (await queue.status()).find((row) => row.id === "example-one").request.prompt,
        request().prompt,
      );
      assert.ok(events.some((event) => event.type === "operator_request_queued"));
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
