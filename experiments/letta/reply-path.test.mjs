import { test } from "node:test";
import assert from "node:assert/strict";
import {
  correctionRequestSourceIds,
  correctionReporterIds,
  durableCandidate,
  turnInput,
  turnExpectsReply,
  replyEvidence,
  recallQuery,
} from "./pilot-reply.mjs";
import { rejectCorrectionRequestEvidence } from "./pilot-model.mjs";
import { encodeUnderstanding } from "./pilot-memory.mjs";
import { toolLifecycle } from "./pilot-tool-lifecycle.mjs";

const request = {
  id: "changing-view-example",
  prompt: "How did the member's view change?",
  requestedAt: "2026-10-16T15:00:00.000Z",
  origin: "operator",
  delivery: "chat",
};
test("operator questions take the direct reply path without inventing community sources", () => {
  const batch = { rows: [], replyTo: null, operatorRequest: request, context: {} };
  const input = turnInput(batch, "revision", "111111111111111111");
  assert.equal(turnExpectsReply(batch), true);
  assert.equal(input.kind, "direct");
  assert.equal(input.operatorRequest.origin, "operator");
  assert.deepEqual(input.messages, []);
  assert.deepEqual(input.memoryContract.observationTargetIds, []);
  assert.match(input.memoryContract.instruction, /not a community member utterance/);
  assert.throws(
    () => turnInput({ ...batch, replyTo: "222222222222222222" }, "revision"),
    /impersonate/,
  );
  assert.throws(
    () => turnInput({ ...batch, rows: [{ id: "222222222222222222" }] }, "revision"),
    /impersonate/,
  );
  assert.equal(turnExpectsReply({ rows: [], replyTo: null }), false);
  assert.equal(
    turnInput({ rows: [], replyTo: "222222222222222222" }, "revision").instruction,
    "Respond naturally to this member in the room.",
  );
});

test("ordinary direct replies retain their retrieval dependency trace", () => {
  const result = {
    candidate: { content: "memory", audit: [] },
    replyEvidence: { archiveReads: [] },
  };
  assert.deepEqual(durableCandidate({ rows: [], replyTo: "222222222222222222" }, result), {
    content: "memory",
    audit: [],
    replyEvidence: { archiveReads: [] },
  });
  assert.deepEqual(durableCandidate({ rows: [], operatorRequest: request }, result), {
    content: "memory",
    audit: [],
    operatorRequestId: request.id,
    replyEvidence: { archiveReads: [] },
  });
  assert.deepEqual(durableCandidate({ rows: [] }, result), { content: "memory", audit: [] });
});

test("correction requests are context-only and cannot become memory evidence", () => {
  const target = { id: "222222222222222222" };
  const reporter = {
    id: "333333333333333333",
    content:
      "<@444444444444444444> !knowledge correct https://discord.com/channels/111111111111111111/222222222222222222/444444444444444444 Narrow the reading.",
  };
  const batch = {
    rows: [target],
    replyTo: null,
    context: { priorMessages: [reporter], correctionRequests: [{ reporterSource: reporter }] },
  };
  const input = turnInput(batch, "revision", "111111111111111111");
  assert.deepEqual(input.memoryContract.observationTargetIds, [target.id]);
  assert.deepEqual(input.memoryContract.contextOnlyIds, [reporter.id]);
  assert.match(input.memoryContract.instruction, /review context, not community evidence/);
  assert.deepEqual([...correctionRequestSourceIds(batch)], [reporter.id]);
  assert.throws(
    () =>
      rejectCorrectionRequestEvidence(
        { upsert: [{ evidence: [{ messageId: reporter.id }] }] },
        new Set([reporter.id]),
      ),
    /review context, not memory evidence/,
  );
  const privateInput = turnInput(
    {
      rows: [target],
      replyTo: null,
      context: {
        correctionRequests: [
          { reviewOrigin: "private-operator", reviewNote: "Use a narrower reading." },
        ],
      },
    },
    "revision",
    "111111111111111111",
  );
  assert.deepEqual(privateInput.memoryContract.contextOnlyIds, []);
  assert.match(
    privateInput.memoryContract.instruction,
    /private operator review is review context/,
  );
});

test("reply provenance separates original memory, turn drafts, immediate context and fresh archive", () => {
  const entry = { key: "club", kind: "statement", statement: "An old view", evidence: [] };
  const trace = replyEvidence(
    { content: encodeUnderstanding([entry]), revision: "before" },
    {
      rows: [{ id: "target" }],
      context: { priorMessages: [{ id: "context" }] },
    },
  );
  trace.observe(
    "read_memory",
    { query: "club" },
    { revision: "before", entries: [entry], sources: [] },
  );
  trace.observe("search_archive", { query: "club" }, { sources: [{ id: "archive" }] });
  trace.observe(
    "read_memory",
    {},
    { revision: "draft", entries: [{ ...entry, statement: "A new view" }], sources: [] },
    { completedAfterModelStream: true },
  );
  trace.observe("read_memory_history", {}, { versions: [] }, { completedAfterModelStream: true });
  trace.observe("search_archive", {}, { sources: [] }, { completedAfterModelStream: true });
  trace.observe(
    "read_community_knowledge",
    { target: "topic", topic: "club" },
    {
      target: "topic",
      key: "club",
      document: {
        entries: [
          {
            annotationId: "club-reading",
            annotationRevision: 3,
            sources: [{ sourceId: "knowledge", sourceRevision: 2 }],
            contextSources: [{ sourceId: "context", sourceRevision: 1 }],
          },
        ],
      },
      sources: [{ id: "knowledge" }],
    },
  );
  const captured = trace.snapshot();
  assert.deepEqual(captured.immediateTargetIds, ["target"]);
  assert.deepEqual(captured.immediateContextIds, ["context"]);
  assert.equal(captured.memoryReads[0].entries[0].origin, "durable-before-turn");
  assert.equal(captured.memoryReads[1].entries[0].origin, "new-or-revised-in-turn-draft");
  assert.equal(captured.archiveReads[0].sources[0].id, "archive");
  assert.equal(captured.memoryReads[0].completedAfterModelStream, false);
  assert.equal(captured.memoryReads[1].completedAfterModelStream, true);
  assert.equal(captured.archiveReads[1].completedAfterModelStream, true);
  assert.equal(captured.historyReads[0].completedAfterModelStream, true);
  assert.deepEqual(captured.communityKnowledgeReads, [
    {
      target: "topic",
      key: "club",
      sourceIds: ["knowledge"],
      candidates: [
        {
          annotationId: "club-reading",
          annotationRevision: 3,
          sourceRevisions: [{ sourceId: "knowledge", sourceRevision: 2 }],
          contextSourceRevisions: [{ sourceId: "context", sourceRevision: 1 }],
        },
      ],
      incomplete: false,
      available: true,
      completedAfterModelStream: false,
    },
  ]);
  captured.memoryReads.length = 0;
  assert.equal(trace.snapshot().memoryReads.length, 2);
});

test("default recall uses the operator question without treating it as a source", () => {
  const batch = { rows: [], operatorRequest: { prompt: "Example member encouragement" } };
  assert.equal(recallQuery({}, batch), "Example member encouragement");
  assert.equal(recallQuery({ query: "Example topic" }, batch), "Example topic");
  assert.equal(recallQuery({ subjects: ["333333333333333333"] }, batch), "");
  assert.equal(recallQuery({ keys: ["club"] }, batch), "");
  assert.equal(recallQuery({ subjects: ["333333333333333333"], query: "club" }, batch), "club");
  assert.equal(
    recallQuery({}, { rows: [{ source: { content: "A real topic" } }] }),
    "A real topic",
  );
});

test("a result ready only after transcript append is labeled post-stream", async () => {
  const tools = toolLifecycle();
  const trace = replyEvidence(
    { content: encodeUnderstanding([]), revision: "before" },
    { rows: [] },
  );
  let releaseAppend;
  const append = new Promise((resolve) => {
    releaseAppend = resolve;
  });
  let executionCompletedAfterModelStream;
  const task = tools.run(async () => {
    executionCompletedAfterModelStream = tools.sealed;
    await append;
    trace.observe(
      "read_memory",
      {},
      { revision: "before", entries: [], sources: [] },
      {
        completedAfterModelStream: tools.sealed,
      },
    );
  });
  await Promise.resolve();
  tools.seal();
  releaseAppend();
  await tools.finish();
  await task;
  assert.equal(executionCompletedAfterModelStream, false);
  assert.equal(trace.snapshot().memoryReads[0].completedAfterModelStream, true);
});

test("discussion evidence preserves inspected bounds, gaps and post-stream availability", () => {
  const trace = replyEvidence(
    { content: encodeUnderstanding([]), revision: "before" },
    { rows: [] },
  );
  const coverage = {
    sources: [{ id: "original" }],
    filters: { after: "2026-01-01T00:00:00Z" },
    remainingGap: { reason: "chain-budget" },
    exhausted: false,
  };
  trace.observe("browse_archive", { query: "architecture" }, coverage);
  trace.observe(
    "browse_archive",
    { channelIds: ["222222222222222222"] },
    { sources: [{ id: "automatic-original" }], exhausted: true },
    { initiatedBy: "chronological-gap-policy" },
  );
  trace.observe(
    "read_discussion",
    { anchorId: "original" },
    { sources: [], gaps: [{ reason: "reply-depth-budget" }], completeDiscussion: false },
    { completedAfterModelStream: true },
  );
  const result = trace.snapshot();
  coverage.remainingGap.reason = "changed-after-snapshot";
  assert.equal(result.archiveReads[0].tool, "browse_archive");
  assert.equal(result.archiveReads[0].coverage.remainingGap.reason, "chain-budget");
  assert.equal(result.archiveReads[0].initiatedBy, "model");
  assert.equal(result.archiveReads[1].initiatedBy, "chronological-gap-policy");
  assert.equal(result.archiveReads[1].sources[0].id, "automatic-original");
  assert.equal(result.archiveReads[2].completedAfterModelStream, true);
  assert.equal(result.archiveReads[2].coverage.completeDiscussion, false);
});

test("correction reporter lookup deduplicates messages without losing cases", () => {
  assert.deepEqual(
    correctionReporterIds([
      { reporterSourceId: "one" },
      { reporterSourceId: "one" },
      { reporterSourceId: "two" },
      { reviewOrigin: "private-operator" },
    ]),
    ["one", "two"],
  );
});

test("retrieved correction requests never become sourced memory while ordinary evidence stays usable", async () => {
  const { memoryPatchSession, encodeUnderstanding, decodeUnderstanding } =
    await import("./pilot-memory.mjs");
  const { digest } = await import("./pilot-store.mjs");
  const guildId = "111111111111111111",
    channelId = "222222222222222222",
    authorId = "333333333333333333";
  const original = {
    id: "555555555555555501",
    guildId,
    channelId,
    authorId,
    content: "The trip is on Friday.",
    createdAt: "2026-10-16T12:00:00Z",
    replyTo: null,
    url: "https://discord.com/channels/111111111111111111/222222222222222222/555555555555555501",
  };
  const report = {
    ...original,
    id: "555555555555555502",
    content:
      "!knowledge correct https://discord.com/channels/111111111111111111/222222222222222222/555555555555555501 The trip was cancelled.",
  };
  const content = encodeUnderstanding([]),
    initial = { content, revision: digest(content) };
  const supplied = new Map([[original.id, original]]);
  const correctionIds = new Set();
  const session = memoryPatchSession(initial, supplied, [original.id], (patch) =>
    rejectCorrectionRequestEvidence(patch, correctionIds),
  );
  supplied.set(report.id, report); // Retrieved after the turn and guard were created.
  const entry = (key, source) => ({
    key,
    kind: "statement",
    subjects: [authorId],
    statement: `A ${key} statement`,
    importance: 1,
    evidence: [{ messageId: source.id, quote: source.content }],
  });
  const observations = [
    { messageId: original.id, decision: "retained", reason: "Source supports the entry." },
  ];
  const rejected = session.apply({
    expectedRevision: initial.revision,
    upsert: [entry("good", original), entry("bad", report)],
    remove: [],
    observations,
  });
  assert.match(rejected.status, /needs_repair/);
  assert.ok(rejected.errors.some((error) => /review context, not memory evidence/.test(error)));
  assert.deepEqual(
    rejected.preservedProposals.map((proposal) => proposal.key),
    ["good"],
  );
  assert.equal(session.complete, false);
  const accepted = session.apply({
    expectedRevision: initial.revision,
    upsert: [],
    remove: [],
    observations,
  });
  assert.match(accepted.status, /staged/);
  assert.deepEqual(
    decodeUnderstanding(session.draft.content).map((item) => item.key),
    ["good"],
  );
});

test("correction request observation targets are identified without dropping their decisions", () => {
  const source = {
    id: "555555555555555502",
    content:
      "<@444444444444444444> !KNOWLEDGE CORRECT https://discord.com/channels/111111111111111111/222222222222222222/555555555555555501 The trip was cancelled.",
  };
  const batch = { rows: [{ id: source.id, source }], replyTo: null, context: {} };
  assert.deepEqual([...correctionRequestSourceIds(batch)], [source.id]);
  const contract = turnInput(batch, "revision", "444444444444444444").memoryContract;
  assert.deepEqual(contract.observationTargetIds, [source.id]);
  assert.match(contract.instruction, /review context, not community evidence/);
});

test("a correction command target requires an irrelevant decision even with legacy memory", async () => {
  const { memoryPatchSession, encodeUnderstanding, decodeUnderstanding } =
    await import("./pilot-memory.mjs");
  const { digest } = await import("./pilot-store.mjs");
  const source = {
    id: "555555555555555502",
    content:
      "!knowledge correct https://discord.com/channels/111111111111111111/222222222222222222/555555555555555501 An older request.",
  };
  const prior = {
    key: "legacy",
    kind: "statement",
    subjects: ["333333333333333333"],
    statement: "A preserved legacy entry",
    importance: 1,
    evidence: [{ messageId: source.id, quote: "An older request." }],
    updated: "2026-10-16T12:00:00Z",
  };
  const content = encodeUnderstanding([prior]);
  const initial = { content, revision: digest(content) };
  const session = memoryPatchSession(initial, new Map([[source.id, source]]), [source.id]);
  const observation = (decision) => ({
    messageId: source.id,
    decision,
    reason: "Review request is not evidence.",
  });
  const rejected = session.apply({
    expectedRevision: initial.revision,
    upsert: [],
    remove: [],
    observations: [observation("retained")],
  });
  assert.match(rejected.status, /needs_repair/);
  assert.ok(rejected.errors.some((error) => /review context, not memory evidence/.test(error)));
  const accepted = session.apply({
    expectedRevision: initial.revision,
    upsert: [],
    remove: [],
    observations: [observation("irrelevant")],
  });
  assert.match(accepted.status, /staged/);
  assert.deepEqual(decodeUnderstanding(session.draft.content), [prior]);
});
