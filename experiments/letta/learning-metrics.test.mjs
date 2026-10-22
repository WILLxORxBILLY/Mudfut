import assert from "node:assert/strict";
import { reviewMetrics, transcriptMetrics, unionDuration } from "./pilot-learning-metrics.mjs";

assert.equal(
  unionDuration(
    [
      [0, 20],
      [10, 30],
      [29, 40],
    ],
    15,
    35,
  ),
  20,
);
const t = (seconds) => new Date(Date.UTC(2026, 9, 16) + seconds * 1000).toISOString();
const work = (id, ids, created, completed, status = "done") => ({
  id,
  source_ids: ids,
  created_at: t(created),
  completed_at: completed === null ? null : t(completed),
  status,
  history_episode: "auto-" + id,
  observations: ids.map((messageId) => ({ messageId, decision: "retained" })),
});
const reviews = reviewMetrics(
  [
    {
      manifest: { sourceIds: ["old", "fresh", "pending"] },
      context_ids: ["context"],
      status: "done",
    },
  ],
  [
    work("first", ["old"], 0, 5),
    work("replay", ["old", "fresh"], 10, 15),
    work("poison", ["pending"], 20, null, "prepared"),
  ],
  t(10),
);
assert.equal(reviews.recentReviewCount, 1);
assert.equal(reviews.recentFirstReviews[0].id, "fresh");
assert.equal(reviews.repeatedCompletedTargetOccurrences, 1);
assert.deepEqual(reviews.committedTargetIds, ["old", "fresh"]);
assert.deepEqual(reviews.loadedContextIds, ["context"]);

const stage = (phase, offsetMs, durationMs) => ({ phase, offsetMs, durationMs, success: true });
const events = [
  {
    type: "latency",
    scope: "cycle",
    historyEpisode: "auto-old",
    startedAt: t(0),
    at: t(20),
    stages: [stage("model_turn", 0, 20000)],
  },
  {
    type: "input",
    otid: "normal",
    at: t(30),
    input: { addressedToBot: true, messages: [{ id: "source", createdAt: t(10) }] },
  },
  {
    type: "latency",
    scope: "model",
    otid: "normal",
    startedAt: t(30),
    at: t(40),
    stages: [
      stage("model_stream", 0, 8000),
      stage("tool:read_memory", 2000, 6000),
      stage("tool:search_archive", 7000, 2000),
      stage("tools_drain", 8000, 1000),
    ],
  },
  { type: "discord_reply", sourceId: "source", id: "reply", at: t(40) },
  {
    type: "latency",
    scope: "cycle",
    replyTo: "source",
    startedAt: t(30),
    at: t(41),
    stages: [stage("model_turn", 0, 9000), stage("delivery", 9000, 1000)],
  },
  {
    type: "input",
    otid: "operator",
    at: t(42),
    input: { addressedToBot: true, operatorRequest: { id: "real" }, messages: [] },
  },
  {
    type: "latency",
    scope: "model",
    otid: "operator",
    startedAt: t(42),
    at: t(43),
    stages: [stage("model_stream", 0, 1000)],
  },
];
const metrics = transcriptMetrics(events.map((e) => JSON.stringify(e)).join("\n"), t(0));
assert.equal(metrics.ordinaryDelivered.length, 1);
assert.equal(metrics.ordinaryDelivered[0].totalMs, 30000);
assert.equal(metrics.ordinaryDelivered[0].observedPriorWorkMs, 10000);
assert.equal(metrics.ordinaryDelivered[0].observedPriorWorkByKindMs.historical, 10000);
assert.equal(metrics.ordinaryDelivered[0].unassignedMs, 10000);
assert.equal(metrics.models[0].toolUnionMs, 7000);
assert.equal(metrics.models[1].kind, "operator");
assert.equal(metrics.summaries.ordinary.cycles, 1);
assert.equal(metrics.inputsWithoutCompletedModelTiming.length, 0);
console.log(
  "Learning metrics checks passed: immutable receipts, replay exclusion, context separation, overlapping tools and unassigned ordinary wait.",
);
