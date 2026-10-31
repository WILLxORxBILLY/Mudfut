import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeUnderstanding, readUnderstanding, selectUnderstanding } from "./pilot-memory.mjs";

// Fictional cases, independent of live state or model-generated answers.
const alice = "333333333333333333";
const bob = "444444444444444444";
const entry = (key, statement, extra = {}) => ({
  key,
  statement,
  kind: "statement",
  subjects: [alice],
  importance: 2,
  updated: "2026-01-01T00:00:00.000Z",
  evidence: [{ messageId: "555555555555555555", quote: statement }],
  ...extra,
});
const keys = (entries, options) => selectUnderstanding(entries, options).map((e) => e.key);

test("short memory topics match whole tokens without unrelated high-importance fillers", () => {
  const entries = [
    entry("furniture", "The chair needs repair", { importance: 3 }),
    entry("gardening", "The garden needs watering", { importance: 3 }),
    entry("automation", "AI requires careful evaluation", { importance: 1 }),
  ];
  for (const query of ["AI", "ai", "Ai"])
    assert.deepEqual(keys(entries, { query }), ["automation"]);
  assert.deepEqual(keys(entries, { query: "ZZ" }), []);
});

test("short topics in keys and topic metadata participate in recall", () => {
  const entries = [
    entry("eu-membership", "Mira supports membership"),
    entry("board-game", "Rowan prefers this game", { topics: ["Go"] }),
    entry("weekend", "Theo will go hiking"),
  ];
  assert.deepEqual(keys(entries, { query: "EU" }), ["eu-membership"]);
  assert.deepEqual(keys(entries, { query: "go" }), ["board-game", "weekend"]);
});

test("compound queries count short topic matches when ranking otherwise similar memories", () => {
  const entries = [
    entry("parking", "Parking policy needs revision", { importance: 3 }),
    entry("automation", "AI policy needs revision", { importance: 1 }),
  ];
  assert.deepEqual(keys(entries, { query: "AI policy" }), ["automation", "parking"]);
});

test("short topics retain person filtering and inference exclusions", () => {
  const entries = [
    entry("alice-automation", "AI evaluations need realistic tasks"),
    entry("bob-automation", "AI evaluations need adversarial tasks", { subjects: [bob] }),
    entry("alice-garden", "The garden needs watering"),
    entry("alice-tentative", "AI may interest Alice", { kind: "inference", importance: 1 }),
  ];
  assert.deepEqual(keys(entries, { query: "AI", subjects: [alice], includeInferences: false }), [
    "alice-automation",
  ]);
  assert.deepEqual(keys(entries, { query: "ZZ", subjects: [alice] }), []);
});

test("a nonempty query with no searchable tokens never becomes an unfiltered memory browse", () => {
  const entries = [entry("gardening", "The garden needs watering")];
  for (const query of ["???", "🧩", "X"])
    for (const subjects of [[], [alice]]) assert.deepEqual(keys(entries, { query, subjects }), []);
  assert.deepEqual(keys(entries, {}), ["gardening"]);
  assert.deepEqual(keys(entries, { query: "  " }), ["gardening"]);
  assert.deepEqual(keys(entries, { subjects: [alice] }), ["gardening"]);
});

test("short-topic reads report actual matches and still require current original evidence", async () => {
  const retained = entry("automation", "AI requires careful evaluation");
  const snapshot = { content: encodeUnderstanding([retained]), revision: "fictional-snapshot" };
  const source = {
    id: retained.evidence[0].messageId,
    guildId: "111111111111111111",
    channelId: "222222222222222222",
    authorId: alice,
    content: retained.statement,
    createdAt: retained.updated,
    url: "https://discord.com/channels/111111111111111111/222222222222222222/555555555555555555",
  };
  const sources = new Map([[source.id, source]]);
  const reads = [];
  const lookup = async (ids) => reads.push(ids);
  const found = await readUnderstanding(snapshot, { query: "AI" }, sources, lookup);
  assert.deepEqual(found.entries, [retained]);
  assert.equal(found.sources[0].messageId, source.id);
  assert.equal(found.coverage.matchingEntries, 1);
  assert.deepEqual(reads, [[source.id]]);
  const absent = await readUnderstanding(snapshot, { query: "ZZ" }, sources, lookup);
  assert.deepEqual(absent.entries, []);
  assert.deepEqual(absent.sources, []);
  assert.equal(absent.coverage.matchingEntries, 0);
  assert.equal(absent.coverage.omittedMatchingEntries, 0);
  assert.deepEqual(absent.coverage.nextKeys, []);
  await assert.rejects(
    readUnderstanding(snapshot, { query: "AI" }, sources, async () => sources.delete(source.id)),
    /Memory evidence changed or disappeared/,
  );
});
