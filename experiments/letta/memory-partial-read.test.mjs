import assert from "node:assert/strict";
import test from "node:test";
import { encodeUnderstanding, readUnderstanding, memoryEvidence } from "./pilot-memory.mjs";

const id = (n) => String(555555555555555500n + BigInt(n));
const source = (n, content) => ({ id: id(n), content, authorId: "333333333333333333" });
const good = source(1, "Fictional sourced understanding");
const review = source(2, "!knowledge correct This note is a request for review");
const changed = source(3, "The original no longer contains its former quote");
const entry = (key, original, quote) => ({
  key,
  kind: "statement",
  subjects: [good.authorId],
  statement: `Private interpretation ${key}`,
  evidence: [{ messageId: original.id, quote }],
  sourceIds: [original.id],
});
const valid = entry("valid", good, "sourced understanding");
const correction = entry("review", review, "request for review");
const stale = entry("stale", changed, "removed quotation");
const lineage = {
  ...valid,
  key: "missing-lineage",
  statement: "Private interpretation missing-lineage",
  sourceIds: [good.id, id(9)],
};
const entries = [valid, correction, stale, lineage];
const snapshot = { content: encodeUnderstanding(entries), revision: "fictional-revision" };
const sources = new Map([good, review, changed].map((row) => [row.id, row]));
const options = { keys: entries.map((row) => row.key) };

test("one inadmissible interpretation cannot hide unrelated validated memory", async () => {
  const before = snapshot.content;
  const result = await readUnderstanding(snapshot, options, sources, async () => {}, {
    allowPartial: true,
  });
  assert.deepEqual(result.entries, [valid]);
  assert.deepEqual(
    result.sources.map((row) => row.messageId),
    [good.id],
  );
  assert.equal(result.coverage.matchingEntries, 4);
  assert.equal(result.coverage.returnedEntries, 1);
  assert.equal(result.coverage.unavailableMatchingEntries, 3);
  assert.deepEqual(result.coverage.unavailableEntries, [
    { key: correction.key, reason: "correction-request-is-review-context" },
    { key: stale.key, reason: "supporting-quote-changed" },
    { key: lineage.key, reason: "supporting-original-unavailable" },
  ]);
  assert.equal(snapshot.content, before);
  assert.equal(sources.size, 3);
  assert(!JSON.stringify(result).includes(correction.statement));
  assert(!JSON.stringify(result).includes(stale.statement));
  assert(!JSON.stringify(result).includes(lineage.statement));
});

test("all withheld entries are explicit unavailable coverage, not absent history", async () => {
  const result = await readUnderstanding(
    snapshot,
    { keys: [correction.key, stale.key, lineage.key] },
    sources,
    async () => {},
    { allowPartial: true },
  );
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.sources, []);
  assert.equal(result.coverage.matchingEntries, 3);
  assert.equal(result.coverage.unavailableMatchingEntries, 3);
  assert.equal(result.totalEntries, 4);
});

test("partial retrieval never suppresses transport or policy failures", async () => {
  for (const code of ["ECONNRESET", "PILOT_RECOVERY_GATE"]) {
    const error = Object.assign(new Error("Fictional lookup failure"), { code });
    await assert.rejects(
      readUnderstanding(
        snapshot,
        options,
        sources,
        async () => {
          throw error;
        },
        { allowPartial: true },
      ),
      (actual) => actual === error,
    );
  }
});

test("strict callers and the underlying evidence assertions remain fail-closed", async () => {
  await assert.rejects(
    readUnderstanding(snapshot, options, sources, async () => {}),
    /changed or disappeared/,
  );
  assert.throws(() => memoryEvidence([correction], sources), /Correction request/);
  assert.throws(() => memoryEvidence([stale], sources), /changed or disappeared/);
});
