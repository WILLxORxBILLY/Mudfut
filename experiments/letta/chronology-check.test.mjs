import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "./pilot-store.mjs";
import {
  memoryHistoryEvidence,
  decodeUnderstanding,
  encodeUnderstanding,
  memoryPatchSession,
  reviseUnderstanding,
  selectUnderstanding,
  readUnderstanding,
} from "./pilot-memory.mjs";

// Fictional sources only: this check never opens a database or live memory.
const alice = "333333333333333333",
  bob = "444444444444444444";
const source = (suffix, content, createdAt, authorId = alice, extra = {}) => ({
  id: "555555555555555" + suffix,
  guildId: "111111111111111111",
  channelId: "222222222222222222",
  authorId,
  content,
  createdAt,
  editedAt: null,
  replyTo: null,
  url: "https://example.invalid/messages/" + suffix,
  ...extra,
});
const first = source("101", "I prefer closing the club early.", "2026-01-01T12:00:00Z"),
  second = source("102", "I now prefer keeping the club open late.", "2026-06-01T12:00:00Z"),
  earlier = source("103", "I prefer closing the club early.", "2025-12-01T12:00:00Z"),
  other = source("104", "I prefer the copper teapot.", "2026-02-01T12:00:00Z", bob);
const sources = new Map([first, second, earlier, other].map((s) => [s.id, s]));
const entry = (key, support, statement = support.content, extra = {}) => ({
  key,
  kind: "preference",
  subjects: [support.authorId],
  statement,
  importance: 2,
  evidence: [{ messageId: support.id, quote: support.content }],
  ...extra,
});
const snapshot = (entries = []) => {
  const content = encodeUnderstanding(entries);
  return { content, revision: digest(content) };
};
const patch = (previous, upsert, observations = []) => ({
  expectedRevision: previous.revision,
  upsert,
  remove: [],
  observations,
});
const apply = (previous, upsert, now = "2026-08-01T00:00:00Z", available = sources) =>
  reviseUnderstanding(previous, patch(previous, upsert), available, [], now);
const byKey = (value, key) => decodeUnderstanding(value.content).find((e) => e.key === key);
const lineage = (prior, action, extra = {}) => ({
  action,
  previousUpdated: prior.updated,
  reason: "Explicitly reconcile these dated source statements.",
  ...extra,
});

test("a later view records the previous version and retains every ancestral source", () => {
  const previous = apply(snapshot(), [entry("club-hours", first), entry("teapot", other)]);
  const prior = byKey(previous, "club-hours");
  const result = apply(
    previous,
    [entry("club-hours", second, second.content, { lineage: lineage(prior, "revise") })],
    "2026-08-02T00:00:00Z",
  );
  const current = byKey(result, "club-hours");
  assert.deepEqual(current.sourceIds, [first.id, second.id]);
  assert.deepEqual(current.sourceRange, {
    from: "2026-01-01T12:00:00.000Z",
    to: "2026-06-01T12:00:00.000Z",
  });
  assert.deepEqual(current.evidence, entry("club-hours", second).evidence);
  assert.equal(current.created, prior.created);
  const transition = result.audit.transitions[0];
  assert.deepEqual(transition.previous, prior);
  assert.deepEqual(transition.current, current);
  assert.deepEqual(
    transition.predecessors.map((e) => e.key),
    [prior.key],
  );
  assert.deepEqual(transition.supersededKeys, []);
  assert.deepEqual(byKey(result, "teapot"), byKey(previous, "teapot"));
  assert.deepEqual(byKey(previous, "club-hours"), prior);
});

test("older evidence, missing lineage and stale predecessor versions cannot overwrite newer views", () => {
  const previous = apply(snapshot(), [entry("club-hours", second)]);
  const prior = byKey(previous, "club-hours");
  for (const support of [first, earlier, second])
    assert.throws(
      () =>
        apply(previous, [
          entry("club-hours", support, "Return to early closing.", {
            lineage: lineage(prior, "revise"),
          }),
        ]),
      /Older or same-time evidence/,
    );
  assert.throws(() => apply(previous, [entry("club-hours", first)]), /explicit lineage/);
  assert.throws(
    () =>
      apply(previous, [
        entry("club-hours", second, "Return to early closing.", {
          lineage: lineage(prior, "consolidate", { replaces: [] }),
        }),
      ]),
    /consolidat|Older or same-time evidence/,
    "consolidation without another predecessor must not bypass chronological revision checks",
  );
  assert.throws(
    () =>
      apply(previous, [
        entry("club-hours", second, second.content, {
          lineage: lineage(prior, "extend", { previousUpdated: "2020-01-01T00:00:00Z" }),
        }),
      ]),
    /previousUpdated/,
  );
  assert.throws(
    () =>
      apply(previous, [
        entry("club-hours", first, first.content, { lineage: lineage(prior, "extend") }),
      ]),
    /Extension may add evidence, never change a claim/,
  );
});

test("repeated support extends one unchanged claim without duplicate evidence or eviction", () => {
  const previous = apply(snapshot(), [entry("club-hours", first)]);
  let current = apply(previous, [
    entry("club-hours", earlier, first.content, {
      lineage: lineage(byKey(previous, "club-hours"), "extend"),
    }),
  ]);
  current = apply(current, [
    entry("club-hours", earlier, first.content, {
      lineage: lineage(byKey(current, "club-hours"), "extend"),
    }),
  ]);
  assert.equal(decodeUnderstanding(current.content).length, 1);
  assert.deepEqual(byKey(current, "club-hours").sourceIds, [first.id, earlier.id]);
  assert.equal(byKey(current, "club-hours").evidence.length, 2);
  assert.equal(byKey(current, "club-hours").sourceRange.from, "2025-12-01T12:00:00.000Z");
  assert.deepEqual(current.audit.evicted, []);
});

test("explicit consolidation preserves predecessors while unrelated participants and untouched memory stay separate", () => {
  const previous = apply(snapshot(), [
    entry("club-hours", first),
    entry("club-detail", earlier, "Earlier club closing preference."),
    entry("teapot", other),
  ]);
  const prior = byKey(previous, "club-hours");
  const result = apply(previous, [
    entry("club-hours", second, "The club closing preference changed over time.", {
      lineage: lineage(prior, "consolidate", { replaces: ["club-detail"] }),
    }),
  ]);
  assert.equal(byKey(result, "club-detail"), undefined);
  assert.deepEqual(
    new Set(byKey(result, "club-hours").sourceIds),
    new Set([first.id, earlier.id, second.id]),
  );
  assert.equal(byKey(result, "club-hours").evidence.length, 3);
  assert.deepEqual(result.audit.transitions[0].supersededKeys, ["club-detail"]);
  assert.deepEqual(
    result.audit.transitions[0].predecessors.map((e) => e.key),
    ["club-hours", "club-detail"],
  );
  assert.deepEqual(byKey(result, "teapot"), byKey(previous, "teapot"));
  assert.throws(
    () =>
      apply(previous, [
        entry("club-hours", second, second.content, {
          lineage: lineage(prior, "consolidate", { replaces: ["teapot"] }),
        }),
      ]),
    /shared participant/,
  );
  assert.equal(decodeUnderstanding(previous.content).length, 3);
});

test("an actual newer source edit permits correction without rewriting the original audit version", () => {
  const previous = apply(snapshot(), [entry("club-hours", first)]);
  const prior = byKey(previous, "club-hours");
  const edited = {
    ...first,
    content: "Correction: I prefer late closing.",
    editedAt: "2026-08-03T00:00:00Z",
  };
  const available = new Map(sources).set(first.id, edited);
  const result = apply(
    previous,
    [entry("club-hours", edited, edited.content, { lineage: lineage(prior, "correct") })],
    "2026-08-04T00:00:00Z",
    available,
  );
  assert.deepEqual(result.audit.transitions[0].previous.evidence, prior.evidence);
  assert.equal(byKey(result, "club-hours").statement, edited.content);
  assert.deepEqual(byKey(result, "club-hours").sourceIds, [first.id]);
  assert.throws(
    () =>
      apply(
        previous,
        [entry("club-hours", edited, edited.content, { lineage: lineage(prior, "correct") })],
        "2026-08-04T00:00:00Z",
        new Map(sources).set(first.id, { ...edited, editedAt: "2026-07-01T00:00:00Z" }),
      ),
    /Older or same-time evidence/,
  );
});

test("ordinary recall includes sourced tentative inference and linked contrary evidence without unrelated fillers", () => {
  const contrary = source(
    "105",
    "I dislike quiet evenings and prefer a lively crowd.",
    "2026-02-01T12:00:00Z",
    bob,
  );
  const available = new Map(sources).set(contrary.id, contrary);
  const initial = apply(
    snapshot(),
    [entry("contrary", contrary), entry("unrelated", earlier, "A train trip happened.")],
    "2026-08-01T00:00:00Z",
    available,
  );
  const inference = entry("tentative", first, "Alice may prefer the quiet club routine.", {
    kind: "inference",
    importance: 1,
    topics: ["routine"],
    relations: [
      {
        key: "contrary",
        type: "contradicts",
        reason: "A separate speaker prefers an alternative.",
      },
    ],
  });
  const result = apply(initial, [inference], "2026-08-02T00:00:00Z", available);
  assert.deepEqual(
    selectUnderstanding(decodeUnderstanding(result.content), { query: "routine" }).map(
      (e) => e.key,
    ),
    ["tentative", "contrary"],
  );
  assert.deepEqual(
    selectUnderstanding(decodeUnderstanding(result.content), {
      query: "routine",
      includeInferences: false,
    }),
    [],
  );
  assert.throws(() => apply(initial, [{ ...inference, importance: 2 }]), /Tentative inferences/);
  assert.throws(() => apply(initial, [{ ...inference, subjects: [bob] }]), /subjects must occur/);
  assert.throws(
    () =>
      apply(initial, [
        { ...inference, evidence: [{ messageId: first.id, quote: "Unsaid certainty." }] },
      ]),
    /quote a supplied current source exactly/,
  );
});

test("recall follows same-person shared originals once and reports truncated matches", async () => {
  const related = entry("qualification", second, "Club policy has a conditional cost limit.");
  const seed = entry("club-policy", first, "Club policy is restrictive.", {
    sourceIds: [first.id, second.id],
  });
  const unrelated = entry("unrelated-person", { ...second, authorId: bob });
  const distant = entry("distant", other, "A different topic.", { subjects: [alice] });
  related.sourceIds = [second.id, other.id];
  const entries = [seed, related, unrelated, distant].map((e) => ({
    ...e,
    updated: "2026-08-01T00:00:00Z",
  }));
  assert.deepEqual(
    selectUnderstanding(entries, { query: "restrictive" }).map((e) => e.key),
    ["club-policy", "qualification"],
    "Shared originals expand direct seeds, not unrelated subjects or a second hop",
  );
  const many = Array.from({ length: 30 }, (_, n) => ({
    ...entries[0],
    key: "club-" + n,
    evidence: [{ messageId: first.id, quote: first.content }],
    sourceIds: [first.id],
  }));
  const result = await readUnderstanding(
    snapshot(many),
    { query: "club" },
    sources,
    async () => {},
  );
  assert.equal(result.entries.length, 18);
  assert.equal(result.coverage.matchingEntries, 30);
  assert.equal(result.coverage.omittedMatchingEntries, 12);
  assert.equal(result.coverage.nextKeys.length, 8);
  assert.match(result.coverage.caveat, /not complete/);
});

test("valid chronological proposals survive an unrelated invalid write component until a complete repair", () => {
  const initial = apply(snapshot(), [entry("club-hours", first), entry("teapot", other)]);
  const session = memoryPatchSession(initial, sources, [second.id]);
  const revised = entry("club-hours", second, second.content, {
    lineage: lineage(byKey(initial, "club-hours"), "revise"),
  });
  const failed = session.apply(
    patch(
      initial,
      [revised],
      [
        {
          messageId: first.id,
          decision: "retained",
          reason: "Wrong context-only observation target.",
        },
      ],
    ),
  );
  assert.match(failed.status, /needs_repair/);
  assert.deepEqual(failed.preservedProposals, [revised]);
  assert.equal(session.draft.content, initial.content);
  assert.equal(session.complete, false);
  const repaired = session.apply(
    patch(
      initial,
      [],
      [
        {
          messageId: second.id,
          decision: "retained",
          reason: "A genuinely later change of preference.",
        },
      ],
    ),
  );
  assert.equal(session.complete, true);
  assert.equal(repaired.transitions.length, 1);
  assert.equal(byKey(session.draft, "club-hours").statement, second.content);
  assert.deepEqual(byKey(session.draft, "teapot"), byKey(initial, "teapot"));
});

test("revision recall never leaks stale quotes through a whole commit audit", () => {
  const saved = { ...entry("club-hours", first), updated: "2026-08-01T00:00:00Z" };
  const row = {
    id: "1",
    is_current: true,
    key: saved.key,
    entry: saved,
    source_ids: [first.id],
    tombstone: false,
    audit: {
      transitions: [
        {
          key: saved.key,
          action: "correct",
          previous: { statement: "stale secret text" },
          predecessors: [],
        },
      ],
    },
  };
  const valid = memoryHistoryEvidence([row], sources, [saved]);
  assert.match(valid[0].status, /current understanding/);
  assert.equal(JSON.stringify(valid).includes("stale secret text"), false);
  const missing = memoryHistoryEvidence([row], new Map(), [saved]);
  assert.equal(missing[0].entry, null);
  assert.equal(JSON.stringify(missing).includes(first.content), false);
});

test("ordered contrary proposals retain their valid link while an unrelated observation is repaired", () => {
  const opposed = source(
    "105",
    "I prefer keeping the club open late.",
    "2026-02-01T12:00:00Z",
    bob,
  );
  const available = new Map([...sources, [opposed.id, opposed]]);
  const session = memoryPatchSession(snapshot(), available, [first.id, opposed.id]);
  const left = entry("alice-hours", first);
  const right = entry("bob-hours", opposed, opposed.content, {
    relations: [
      {
        key: left.key,
        type: "contradicts",
        reason: "Separate attributed positions remain linked.",
      },
    ],
  });
  const rejected = session.apply({ ...patch(session.draft, [left, right]), observations: [] });
  assert.match(rejected.status, /needs_repair/);
  assert.equal(rejected.preservedProposals.length, 2);
  assert.deepEqual(rejected.preservedProposals[1].relations, right.relations);
  assert.equal(decodeUnderstanding(session.draft.content).length, 0);
  const repaired = session.apply({
    ...patch(session.draft, []),
    observations: [first, opposed].map((s) => ({
      messageId: s.id,
      decision: "retained",
      reason: "Directly sourced useful discussion.",
    })),
  });
  assert.match(repaired.status, /staged/);
  assert.deepEqual(byKey(session.draft, right.key).relations, right.relations);
});

test("memory read captures revision/entries/count before async source refresh and still rejects fresh mutations", async () => {
  const oldEntry = { ...entry("old", first), updated: "2026-01-01T00:00:00Z" };
  const initial = snapshot([oldEntry]);
  let draft = initial,
    release,
    started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const available = new Map(sources);
  const reading = readUnderstanding(draft, { keys: ["old"] }, available, async (ids) => {
    assert.deepEqual(ids, [first.id]);
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  await began;
  draft = snapshot([
    { ...oldEntry, statement: "New draft changed the claim" },
    { ...entry("new", second), updated: "2026-06-01T00:00:00Z" },
  ]);
  release();
  const result = await reading;
  assert.equal(result.revision, initial.revision);
  assert.notEqual(result.revision, draft.revision);
  assert.deepEqual(result.entries, [oldEntry]);
  assert.equal(result.totalEntries, 1);
  assert.equal(result.sources[0].messageId, first.id);
  for (const mutation of ["edit", "delete"])
    await assert.rejects(
      readUnderstanding(initial, { keys: ["old"] }, available, async () => {
        if (mutation === "edit")
          available.set(first.id, { ...first, content: "The original quote was edited away." });
        else available.delete(first.id);
      }),
      /Memory evidence changed or disappeared/,
    );
});

test("combined person/topic recall excludes unrelated matches while linked contrary evidence remains", () => {
  const entries = [
    {
      ...entry("alice-cycling", first, "Alice prefers cycling"),
      updated: "2026-01-01",
      relations: [
        { key: "bob-contrary", type: "contradicts", reason: "Contrary cycling preference" },
      ],
    },
    { ...entry("alice-coffee", first, "Alice prefers coffee"), updated: "2026-01-01" },
    { ...entry("bob-cycling", other, "Bob prefers cycling"), updated: "2026-01-01" },
    { ...entry("bob-contrary", other, "Bob opposes that proposal"), updated: "2026-01-01" },
  ];
  const combined = selectUnderstanding(entries, { query: "cycling", subjects: [alice] }).map(
    (entry) => entry.key,
  );
  assert.deepEqual(combined, ["alice-cycling", "bob-contrary"]);
  assert.ok(
    selectUnderstanding(entries, { subjects: [alice] }).some(
      (entry) => entry.key === "alice-coffee",
    ),
    "Person-only recall keeps other topics for that person",
  );
  assert.ok(
    selectUnderstanding(entries, { query: "cycling" }).some((entry) => entry.key === "bob-cycling"),
    "Topic-only recall keeps other people on that topic",
  );
});
