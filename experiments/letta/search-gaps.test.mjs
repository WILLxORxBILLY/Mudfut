import { test } from "node:test";
import assert from "node:assert/strict";
import { searchGapInvestigator } from "./pilot-search-gaps.mjs";

const guildId = "111111111111111111",
  channelId = "222222222222222222";
const source = (n, minute = n, extra = {}) => ({
  id: String(555555555555555000n + BigInt(n)),
  guildId,
  channelId,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
  ...extra,
});

test("automatic gap investigation derives bounded chronology, is single-flight and spends at most one probe", async () => {
  let release,
    findCalls = 0,
    inspectCalls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = source(1),
    later = source(2, 20),
    middle = source(3, 10);
  const investigator = searchGapInvestigator({
    now: () => 0,
    deadline: 60_000,
    findGap: async (intervals, ids) => {
      findCalls++;
      if (findCalls === 2) {
        assert.deepEqual(ids, [first.id, later.id, middle.id]);
        assert.equal(intervals.length, 2);
        return null;
      }
      assert.deepEqual(ids, [first.id, later.id]);
      assert.deepEqual(intervals, [
        {
          guildId,
          channelId,
          after: first.createdAt,
          before: later.createdAt,
          fromId: first.id,
          toId: later.id,
        },
      ]);
      assert.ok(intervals.every((interval) => !Object.hasOwn(interval, "query")));
      await gate;
      return { ...intervals[0], unseenCandidates: 1 };
    },
    inspectGap: async (gap) => {
      inspectCalls++;
      assert.equal(gap.unseenCandidates, 1);
      assert.equal(gap.guildId, guildId);
      return { sources: [middle], exhausted: true };
    },
  });
  const pending = investigator.observe([first, later]);
  assert.equal((await investigator.observe([first, later])).status, "in-progress");
  release();
  const result = await pending;
  assert.equal(result.status, "inspected");
  assert.deepEqual(result.inspection.sources, [middle]);
  assert.equal((await investigator.observe([first, later])).status, "no-indexed-gap");
  assert.equal(findCalls, 2);
  assert.equal(inspectCalls, 1);
});

test("no gap leaves a later probe available and empty or cross-channel anchors spend nothing", async () => {
  let found = false,
    findCalls = 0,
    probes = 0;
  const investigator = searchGapInvestigator({
    now: () => 0,
    deadline: 60_000,
    findGap: async (intervals) => {
      findCalls++;
      return found ? intervals[0] : null;
    },
    inspectGap: async () => {
      probes++;
      return { sources: [] };
    },
  });
  assert.equal((await investigator.observe([])).status, "no-potential-gap");
  assert.equal(
    (await investigator.observe([source(1), source(2, 5, { channelId: "222222222222222223" })]))
      .status,
    "no-potential-gap",
  );
  assert.equal((await investigator.observe([source(3, 10)])).status, "no-indexed-gap");
  assert.equal(probes, 0);
  found = true;
  assert.equal((await investigator.observe([source(4, 15)])).status, "inspected");
  assert.equal(findCalls, 2);
  assert.equal(probes, 1);
});

test("a later actual gap stays concrete after the automatic probe allowance is spent", async () => {
  let probes = 0;
  const first = source(1, 0),
    middle = source(2, 10),
    last = source(3, 20);
  const investigator = searchGapInvestigator({
    now: () => 0,
    deadline: 60_000,
    findGap: async (intervals) => ({ ...intervals[0], unreadCountCapped: 4 }),
    inspectGap: async () => {
      probes++;
      return { sources: [middle] };
    },
  });
  assert.equal((await investigator.observe([first, last])).status, "inspected");
  const remaining = await investigator.observe([]);
  assert.equal(remaining.status, "probe-budget-used");
  assert.deepEqual(remaining.gap, {
    guildId,
    channelId,
    after: first.createdAt,
    before: middle.createdAt,
    fromId: first.id,
    toId: middle.id,
    unreadCountCapped: 4,
  });
  assert.equal(remaining.inspection, undefined);
  assert.equal(probes, 1);
});

test("insufficient remaining deadline exposes an uninspected interval without querying", async () => {
  const investigator = searchGapInvestigator({
    now: () => 40_001,
    deadline: 60_000,
    findGap: () => assert.fail("Insufficient time must not start an index query"),
    inspectGap: () => assert.fail("Insufficient time must not inspect"),
  });
  const result = await investigator.observe([source(1), source(2)]);
  assert.equal(result.status, "budget-uninspected");
  assert.equal(result.gap.after, source(1).createdAt);
});

test("timestamp ties retain inclusive bounds and snowflake order; probe failures propagate once", async () => {
  const first = source(1, 0),
    last = source(3, 0);
  let probes = 0;
  const investigator = searchGapInvestigator({
    now: () => 0,
    deadline: 60_000,
    findGap: async (intervals, ids) => {
      assert.deepEqual(ids, [last.id, first.id]);
      assert.equal(intervals[0].after, first.createdAt);
      assert.equal(intervals[0].before, first.createdAt);
      assert.equal(intervals[0].fromId, first.id);
      assert.equal(intervals[0].toId, last.id);
      return intervals[0];
    },
    inspectGap: async () => {
      probes++;
      throw new Error("Source read failed");
    },
  });
  await assert.rejects(investigator.observe([last, first]), /Source read failed/);
  assert.equal((await investigator.observe([first, last])).status, "probe-budget-used");
  assert.equal(probes, 1);
});

test("candidate and anchor ceilings stay explicit and never join different guilds", async () => {
  const findGap = async (intervals) => {
    assert.equal(intervals.length, 8);
    assert.ok(intervals.every((interval) => interval.guildId === guildId));
    return null;
  };
  const investigator = searchGapInvestigator({
    findGap,
    inspectGap: () => assert.fail(),
    now: () => 0,
    deadline: 60_000,
  });
  await investigator.observe(Array.from({ length: 12 }, (_, n) => source(n + 1, n * 2)));
  const other = searchGapInvestigator({
    findGap: () => assert.fail(),
    inspectGap: () => assert.fail(),
    now: () => 0,
    deadline: 60_000,
  });
  assert.equal(
    (await other.observe([source(1), source(2, 1, { guildId: "111111111111111112" })])).status,
    "no-potential-gap",
  );
  const bounded = searchGapInvestigator({
    findGap: () => assert.fail(),
    inspectGap: () => assert.fail(),
    now: () => 0,
    deadline: 60_000,
  });
  assert.equal(
    (await bounded.observe(Array.from({ length: 513 }, (_, n) => source(n + 1)))).status,
    "anchor-budget-uninspected",
  );
});

test("discovery leaves the read for model-selected relevant anchors rather than an earlier wider interval", async () => {
  const offTopicStart = source(1, 0),
    offTopicEnd = source(2, 100);
  const relevantStart = source(3, 110),
    relevantMiddle = source(4, 115),
    relevantEnd = source(5, 120);
  let probes = 0,
    discoveries = 0;
  const investigator = searchGapInvestigator({
    now: () => 0,
    deadline: 60_000,
    findGap: async (intervals, ids) => {
      assert.deepEqual(ids, [
        offTopicStart.id,
        offTopicEnd.id,
        relevantStart.id,
        relevantMiddle.id,
        relevantEnd.id,
      ]);
      discoveries++;
      if (discoveries === 1) {
        assert.equal(intervals[0].fromId, offTopicStart.id);
        return intervals[0];
      }
      assert.equal(intervals.length, 1);
      assert.equal(intervals[0].fromId, relevantStart.id);
      assert.equal(intervals[0].toId, relevantEnd.id);
      assert.ok(!Object.hasOwn(intervals[0], "query"));
      return { ...intervals[0], unreadCountCapped: 2 };
    },
    inspectGap: async (gap) => {
      probes++;
      assert.equal(gap.fromId, relevantStart.id);
      return { sources: [] };
    },
  });
  const discovered = await investigator.observe(
    [offTopicStart, offTopicEnd, relevantStart, relevantMiddle, relevantEnd],
    { inspect: false },
  );
  assert.equal(discovered.status, "gap-uninspected");
  assert.equal(probes, 0);
  const selected = await investigator.investigate({
    fromId: relevantEnd.id,
    toId: relevantStart.id,
    reason: "These originals bracket a relevant disagreement",
  });
  assert.equal(selected.status, "inspected");
  assert.equal(selected.selectionReason, "These originals bracket a relevant disagreement");
  assert.equal(probes, 1);
  const repeated = await investigator.investigate({
    fromId: relevantStart.id,
    toId: relevantEnd.id,
    reason: "Check remaining material",
  });
  assert.equal(repeated.status, "probe-budget-used");
  assert.equal(probes, 1);
});

test("selected investigation rejects malformed, unknown, cross-scope and overlong intervals before index reads", async () => {
  const investigator = searchGapInvestigator({
    now: () => 0,
    deadline: 60_000,
    findGap: () => assert.fail("Invalid anchors must fail before index reads"),
    inspectGap: () => assert.fail(),
  });
  await investigator.observe([source(1)], { inspect: false });
  for (const input of [
    null,
    [],
    {},
    { fromId: source(1).id, toId: source(2).id, reason: "unknown" },
    { fromId: source(1).id, toId: source(1).id, reason: "same" },
    { fromId: source(1).id, toId: source(2).id, reason: " " },
    { fromId: source(1).id, toId: source(2).id, reason: "x".repeat(301) },
    { fromId: source(1).id, toId: source(2).id, reason: "valid", after: source(1).createdAt },
  ])
    await assert.rejects(investigator.investigate(input));
  for (const extra of [
    { guildId: "111111111111111112" },
    { channelId: "222222222222222223" },
    { createdAt: new Date(Date.parse(source(1).createdAt) + 24 * 60 * 60_000 + 1).toISOString() },
  ]) {
    const scoped = searchGapInvestigator({
      now: () => 0,
      deadline: 60_000,
      findGap: async () => null,
      inspectGap: () => assert.fail(),
    });
    await scoped.observe([source(1), source(2, 2, extra)], { inspect: false });
    await assert.rejects(
      scoped.investigate({
        fromId: source(1).id,
        toId: source(2).id,
        reason: "Crossing scope must fail",
      }),
      /share a guild\/channel/,
    );
  }
});

test("selected no-gap checks preserve the allowance and selected calls share deadline and single-flight", async () => {
  let clock = 0,
    found = false,
    release,
    probes = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = source(1),
    last = source(2, 20);
  const investigator = searchGapInvestigator({
    now: () => clock,
    deadline: 60_000,
    findGap: async (intervals) => {
      if (!found) return null;
      await gate;
      return intervals[0];
    },
    inspectGap: async () => {
      probes++;
      return { sources: [] };
    },
  });
  await investigator.observe([first, last], { inspect: false });
  const selection = {
    fromId: first.id,
    toId: last.id,
    reason: "Inspect a relevant chronological development",
  };
  assert.equal((await investigator.investigate(selection)).status, "no-indexed-gap");
  found = true;
  const pending = investigator.investigate(selection);
  assert.equal((await investigator.investigate(selection)).status, "in-progress");
  clock = 40_001;
  release();
  assert.equal((await pending).status, "budget-uninspected");
  assert.equal(probes, 0);
});
