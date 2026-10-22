import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { state } from "./runtime.mjs";
import { digest } from "./pilot-store.mjs";
import { decodeUnderstanding, encodeUnderstanding } from "./pilot-memory.mjs";
import { postgresUnderstanding } from "./pilot-memory-postgres.mjs";

const entry = (
  key,
  statement = "Useful existing understanding",
  sources = ["555555555555555501"],
) => ({
  key,
  kind: "statement",
  subjects: ["333333333333333333"],
  statement,
  evidence: sources.map((messageId) => ({ messageId, quote: statement })),
  importance: 2,
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-01T00:00:00.000Z",
});

test("PostgreSQL memory requires the existing identity before accessing legacy state", async () => {
  await assert.rejects(postgresUnderstanding({}, {}), /existing agent identity/);
});

test(
  "lossless PostgreSQL migration, revision history, capacity growth and mutation recovery",
  {
    skip: process.env.CHECK_DATABASE !== "1",
  },
  async () => {
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const admin = new pg.Client(credentials);
    await admin.connect();
    const database = "mudfut_memory_check_" + randomUUID().replaceAll("-", "");
    let db, second;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      db = new pg.Client({ ...credentials, database });
      second = new pg.Client({ ...credentials, database });
      await db.connect();
      await second.connect();
      const originalEntries = [
        {
          ...entry("prior"),
          sourceIds: ["555555555555555499"],
          lineage: { sourceIds: ["555555555555555500", "555555555555555501"] },
        },
        entry("survivor", "A useful old memory that must survive", ["555555555555555502"]),
      ];
      // Noncanonical whitespace/order verifies that migration keeps exact bytes/SHA.
      const legacyContent = encodeUnderstanding(originalEntries).replace(
        '"version":2',
        '"version": 2',
      );
      const legacyRevision = digest(legacyContent);
      let legacyReads = 0;
      const legacy = {
        read: async () => {
          legacyReads++;
          return { content: legacyContent, revision: legacyRevision };
        },
        write: async () => assert.fail("Migration must not rewrite native memory"),
        legacy: async () => ({ content: "unchanged native index" }),
      };
      const events = [];
      const adapter = await postgresUnderstanding(db, legacy, {
        agentId: "existing-agent",
        record: async (event) => events.push(event),
      });
      assert.deepEqual(await adapter.read(), { content: legacyContent, revision: legacyRevision });
      assert.equal(adapter.migrationReceipt.entryCount, 2);
      assert.equal(adapter.migrationReceipt.revision, legacyRevision);
      assert.equal(legacyReads, 1);
      assert.deepEqual(await adapter.legacy(), { content: "unchanged native index" });
      const imported = (await db.query("SELECT content,revision FROM pilot_memory_migrations"))
        .rows[0];
      assert.deepEqual(imported, { content: legacyContent, revision: legacyRevision });
      assert.equal(
        (await adapter.versions({ key: "prior" }))[0].entry_text,
        JSON.stringify(originalEntries[0]),
      );
      const repeat = await postgresUnderstanding(
        second,
        { read: async () => assert.fail("PG authority cannot fall back to legacy") },
        { agentId: "existing-agent" },
      );
      assert.deepEqual(repeat.migrationReceipt, adapter.migrationReceipt);
      assert.deepEqual(await repeat.read(), await adapter.read());
      await assert.rejects(
        postgresUnderstanding(second, legacy, { agentId: "different-agent" }),
        /identity differs/,
      );
      assert.equal(legacyReads, 1);

      const expanded = [
        ...originalEntries,
        ...Array.from({ length: 145 }, (_, i) =>
          entry(`growing-${i}`, `Remember ${i}: ` + "x".repeat(900)),
        ),
      ];
      const largeContent = encodeUnderstanding(expanded);
      assert.ok(largeContent.length > 96000 && expanded.length > 128);
      const grown = await adapter.write({
        content: largeContent,
        expectedRevision: legacyRevision,
        workId: "real-work-1",
        audit: [
          { reason: "bounded reading added understanding" },
          {
            observations: [
              {
                messageId: "555555555555555501",
                decision: "retained",
                reason: "Useful old context preserved",
              },
            ],
          },
        ],
      });
      const arrayAudit = (
        await db.query("SELECT audit FROM pilot_memory_commits WHERE work_id=$1", ["real-work-1"])
      ).rows[0].audit;
      assert.ok(
        Array.isArray(arrayAudit),
        "Actual candidate audit array must retain JSON array shape",
      );
      assert.equal(arrayAudit[0].reason, "bounded reading added understanding");
      assert.deepEqual(arrayAudit[1].observations, [
        {
          messageId: "555555555555555501",
          decision: "retained",
          reason: "Useful old context preserved",
        },
      ]);
      assert.equal(decodeUnderstanding((await adapter.read()).content).length, expanded.length);
      assert.equal(
        (await adapter.versions({ key: "survivor" })).length,
        1,
        "Unchanged entries create no redundant versions",
      );
      const revisionsBeforeReplay = (
        await db.query("SELECT count(*)::integer AS count FROM pilot_memory_commits")
      ).rows[0].count;
      await repeat.write({
        content: largeContent,
        expectedRevision: legacyRevision,
        workId: "real-work-1",
      });
      assert.equal(
        (await db.query("SELECT count(*)::integer AS count FROM pilot_memory_commits")).rows[0]
          .count,
        revisionsBeforeReplay,
        "Recovery of the same committed bytes is idempotent",
      );
      await assert.rejects(
        repeat.write({
          content: encodeUnderstanding(originalEntries),
          expectedRevision: legacyRevision,
        }),
        /Memory changed/,
      );
      await assert.rejects(
        adapter.write({
          content: encodeUnderstanding([originalEntries[0], originalEntries[0]]),
          expectedRevision: grown.revision,
        }),
        /unique entry keys/,
      );
      await assert.rejects(
        adapter.write({
          content: encodeUnderstanding([
            ...expanded,
            { ...entry("invalid-lineage"), sourceIds: "555555555555555501" },
          ]),
          expectedRevision: grown.revision,
        }),
        /must be arrays/,
      );
      assert.deepEqual(await adapter.read(), { content: largeContent, revision: grown.revision });

      const changed = expanded.map((item) =>
        item.key === "prior"
          ? { ...item, statement: "Later correction", updated: "2026-10-16T00:00:00.000Z" }
          : item,
      );
      const corrected = await adapter.write({
        content: encodeUnderstanding(changed),
        expectedRevision: grown.revision,
        workId: "correction",
        audit: { correctionOf: "prior" },
      });
      const versions = await adapter.versions({ key: "prior" });
      assert.equal(versions.length, 2);
      assert.equal(versions[0].is_current, true);
      assert.equal(versions[1].is_current, false);
      assert.equal(versions[0].previous_version_id, versions[1].id);
      assert.equal(versions[1].entry.statement, originalEntries[0].statement);
      assert.equal(versions[0].audit.correctionOf, "prior");
      assert.deepEqual(
        await adapter.affected(["555555555555555500"]),
        ["555555555555555501", "555555555555555499", "555555555555555500"],
        "Prior lineage participates in invalidation",
      );
      assert.deepEqual(
        await adapter.affected(["555555555555555499"]),
        ["555555555555555501", "555555555555555499", "555555555555555500"],
        "Engine top-level sourceIds participate in invalidation",
      );
      await adapter.invalidate(["555555555555555500"]);
      assert.ok(
        !decodeUnderstanding((await adapter.read()).content).some((item) => item.key === "prior"),
      );
      const tombstones = await adapter.versions({ key: "prior" });
      assert.equal(tombstones[0].tombstone, true);
      assert.equal(tombstones[0].entry_text, null);
      assert.equal(tombstones[0].previous_version_id, versions[0].id);
      assert.deepEqual(tombstones[0].source_ids, [
        "555555555555555501",
        "555555555555555499",
        "555555555555555500",
      ]);
      assert.deepEqual(
        decodeUnderstanding((await adapter.read()).content).find((item) => item.key === "survivor"),
        originalEntries[1],
      );
      const survivingState = await adapter.read();
      await adapter.invalidate(["nonexistent-source"]);
      assert.deepEqual(
        await adapter.read(),
        survivingState,
        "Empty invalidation must not reserialize/reorder memory",
      );
      const resurrected = await adapter.write({
        content: corrected.content,
        expectedRevision: survivingState.revision,
      });
      const readded = await adapter.versions({ key: "prior" });
      assert.equal(
        readded[0].previous_version_id,
        tombstones[0].id,
        "Reintroduced keys retain the tombstone lineage",
      );
      assert.equal(readded[0].tombstone, false);
      assert.equal(readded[0].is_current, true);
      assert.ok(
        readded.slice(1).every((version) => version.is_current === false),
        "Restored identical entries do not mark prior versions current",
      );
      assert.equal(
        resurrected.revision,
        corrected.revision,
        "Recurrent content hashes do not overwrite historical commit IDs",
      );
      await assert.rejects(
        db.query("UPDATE pilot_memory_versions SET entry_text='lost'"),
        /append-only/,
      );
      await assert.rejects(db.query("DELETE FROM pilot_memory_migrations"), /append-only/);
      await assert.rejects(db.query("DELETE FROM pilot_memory_commits"), /append-only/);

      const failure = await postgresUnderstanding(second, legacy, {
        agentId: "existing-agent",
        record: async () => {
          throw new Error("audit unavailable");
        },
      });
      await assert.rejects(
        failure.write({
          content: encodeUnderstanding([...changed, entry("must-rollback")]),
          expectedRevision: resurrected.revision,
        }),
        /audit unavailable/,
      );
      assert.equal((await adapter.versions({ key: "must-rollback" })).length, 0);
      assert.equal((await adapter.read()).revision, resurrected.revision);
      assert.ok(events.some((event) => event.type === "memory_migrated"));
      assert.ok(events.some((event) => event.type === "memory_revision"));
      assert.equal(legacyReads, 1);
      const concurrentBase = await adapter.read();
      const concurrentEntries = decodeUnderstanding(concurrentBase.content);
      const races = await Promise.allSettled([
        adapter.write({
          content: encodeUnderstanding([...concurrentEntries, entry("concurrent-a")]),
          expectedRevision: concurrentBase.revision,
        }),
        repeat.write({
          content: encodeUnderstanding([...concurrentEntries, entry("concurrent-b")]),
          expectedRevision: concurrentBase.revision,
        }),
      ]);
      assert.equal(races.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal(
        races.filter(
          (item) => item.status === "rejected" && /Memory changed/.test(item.reason.message),
        ).length,
        1,
      );
      assert.deepEqual(
        await adapter.read(),
        await repeat.read(),
        "Concurrent adapters agree after row-locked optimistic writes",
      );
    } finally {
      await second?.end();
      await db?.end();
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  },
);
