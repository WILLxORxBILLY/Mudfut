import assert from "node:assert/strict";
import { test } from "node:test";
import { derivedViewWorker } from "./pilot-derived-views.mjs";

// The identifiers and source URL are synthetic. The claim shape mirrors the
// separately retained finance-quiz evaluation, whose real evidence must remain
// in the private research directory rather than this repository.
const memberId = "member-finance";
const sourceR1 = {
  sourceId: "finance-quiz-disability-insurance",
  revisionId: "r1",
  authorId: memberId,
  exactQuote: "Private disability insurance is not a basic question for most people.",
  canonicalPermalink:
    "https://discord.com/channels/guild/channel/finance-quiz-disability-insurance",
};
const interpretation = (
  source,
  text = "The speaker described private disability insurance as an uncommon baseline concern.",
) => ({
  subjectMemberId: memberId,
  topic: "disability-insurance",
  interpretation: text,
  source,
});

test("source evidence flows through attributed interpretation into profile and wiki views", () => {
  const worker = derivedViewWorker();
  worker.registerSource(sourceR1);
  const result = worker.apply(worker.prepare(interpretation(sourceR1)));
  assert.equal(result.disposition, "applied");
  assert.deepEqual(result.profile.entries, [
    {
      interpretation: interpretation(sourceR1).interpretation,
      sourceId: sourceR1.sourceId,
      sourceRevisionId: "r1",
      authorId: memberId,
      exactQuote: sourceR1.exactQuote,
      canonicalPermalink: sourceR1.canonicalPermalink,
    },
  ]);
  assert.deepEqual(result.wiki.entries, result.profile.entries);
});

test("source correction rejects stale worker results, rebuilds dependents and blocks delayed exports", () => {
  const worker = derivedViewWorker();
  worker.registerSource(sourceR1);
  const staleWork = worker.prepare(interpretation(sourceR1));
  const first = worker.apply(staleWork);
  assert.equal(first.disposition, "applied");
  const delayedProfile = worker.prepareExport({ target: "profile", key: memberId });
  const delayedWiki = worker.prepareExport({ target: "wiki", key: "disability-insurance" });
  const sourceR2 = {
    ...sourceR1,
    revisionId: "r2",
    exactQuote:
      "Private disability insurance is uncommon, but public coverage can fall short for higher-paid jobs.",
  };
  worker.correctSource(sourceR2);
  assert.deepEqual(worker.apply(staleWork), { disposition: "stale-source" });
  assert.deepEqual(worker.readProfile(memberId).entries, []);
  assert.deepEqual(worker.readWiki("disability-insurance").entries, []);
  const rebuilt = worker.apply(
    worker.prepare(
      interpretation(
        sourceR2,
        "The speaker called private coverage uncommon while qualifying that public coverage may be inadequate for higher-paid jobs.",
      ),
    ),
  );
  assert.equal(rebuilt.disposition, "applied");
  assert.ok(rebuilt.profile.revision > first.profile.revision);
  assert.ok(rebuilt.wiki.revision > first.wiki.revision);
  assert.equal(rebuilt.profile.entries.length, 1);
  assert.equal(rebuilt.profile.entries[0].sourceRevisionId, "r2");
  assert.equal(rebuilt.profile.entries[0].exactQuote, sourceR2.exactQuote);
  assert.deepEqual(rebuilt.wiki.entries, rebuilt.profile.entries);
  assert.deepEqual(worker.commitExport(delayedProfile), { disposition: "stale-view" });
  assert.deepEqual(worker.commitExport(delayedWiki), { disposition: "stale-view" });
  assert.equal(worker.readExport({ target: "profile", key: memberId }), undefined);
  assert.equal(worker.readExport({ target: "wiki", key: "disability-insurance" }), undefined);
  assert.deepEqual(worker.readReceipts(), [
    {
      receiptId: 1,
      type: "stale-worker-result",
      workId: staleWork.workId,
      sourceId: sourceR1.sourceId,
      preparedSourceRevisionId: "r1",
      currentSourceRevisionId: "r2",
    },
    {
      receiptId: 2,
      type: "stale-export",
      target: "profile",
      key: memberId,
      preparedViewRevision: delayedProfile.viewRevision,
      currentViewRevision: rebuilt.profile.revision,
    },
    {
      receiptId: 3,
      type: "stale-export",
      target: "wiki",
      key: "disability-insurance",
      preparedViewRevision: delayedWiki.viewRevision,
      currentViewRevision: rebuilt.wiki.revision,
    },
  ]);
  const current = worker.prepareExport({ target: "profile", key: memberId });
  assert.deepEqual(worker.commitExport(current), { disposition: "exported" });
  assert.deepEqual(worker.readExport({ target: "profile", key: memberId }), {
    viewRevision: rebuilt.profile.revision,
    document: current.document,
  });
});

test("an interpretation cannot attribute a source to another member", () => {
  const worker = derivedViewWorker();
  worker.registerSource(sourceR1);
  assert.throws(
    () => worker.prepare({ ...interpretation(sourceR1), subjectMemberId: "another-member" }),
    /attribute the source to its author/,
  );
});

test("a worker cannot alter a prepared interpretation after its source snapshot", () => {
  const worker = derivedViewWorker();
  worker.registerSource(sourceR1);
  const prepared = worker.prepare(interpretation(sourceR1));
  prepared.interpretation.interpretation = "The source says something else.";
  assert.deepEqual(worker.apply(prepared), { disposition: "stale-source" });
});
