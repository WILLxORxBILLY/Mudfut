// Synthetic regression from the real-slice review. No database, model or Discord I/O.
// Run: node experiments/letta/community-knowledge-projection.check.mjs
import assert from "node:assert/strict";
import { annotationsFromUnderstanding } from "./community-knowledge.mjs";

const sourceId = "555555555555555501";
const episode = { key: "trip", sourceIds: [sourceId], contextIds: [] };
const entry = {
  key: "trip-qualified-preference",
  kind: "statement",
  subjects: ["333333333333333333"],
  statement: "The speaker prefers the train but would drive if service stops.",
  evidence: [
    { messageId: sourceId, quote: "I prefer the train." },
    { messageId: sourceId, quote: "I would drive if service stops." },
  ],
};

assert.equal(
  annotationsFromUnderstanding([{ ...entry, evidence: entry.evidence.slice(0, 1) }], episode)
    .length,
  1,
  "control: the source-contained entry is otherwise admissible",
);
const projected = annotationsFromUnderstanding([entry], episode);
assert.equal(
  projected.length,
  1,
  "two quotes from one original must not silently drop a candidate",
);
assert.deepEqual(projected[0].sourceIds, [sourceId]);
assert.equal(projected[0].kind, "statement");
assert.deepEqual(
  projected[0].sourceQuotes,
  entry.evidence.map(({ messageId, quote }) => ({ sourceId: messageId, quote })),
  "source identity may deduplicate, but every supporting quote span must remain",
);
console.log("Qualified multi-quote source projection: passed");
