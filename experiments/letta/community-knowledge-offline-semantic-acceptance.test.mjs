// Reads private evaluator proposals and the read-only v6 package, then proves
// them through the ordinary annotation/view lifecycle in disposable PostgreSQL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { state } from "./runtime.mjs";
import { communityKnowledge, renderKnowledgeView } from "./community-knowledge.mjs";

async function withDatabase(run) {
  const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
  const admin = new pg.Client(credentials);
  await admin.connect();
  const database = "mudfut_semantic_" + randomUUID().replaceAll("-", "");
  let db;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    db = new pg.Client({ ...credentials, database });
    await db.connect();
    await run(db, await communityKnowledge(db));
  } finally {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
}

function toSource(item) {
  const url = new URL(item.canonicalPermalink);
  const parts = url.pathname.split("/");
  return {
    id: item.sourceId ?? parts[4],
    guildId: parts[2],
    channelId: parts[3],
    authorId: item.authorId,
    authorName: item.authorName,
    content: item.exactMessage,
    createdAt: item.createdAt,
    editedAt: null,
    replyTo: item.replyTo ?? null,
    url: item.canonicalPermalink,
  };
}

function candidateFromRecord(record) {
  return {
    id: record.annotationId,
    sourceIds: record.directEvidence.map((item) => item.sourceId),
    subjectIds: record.subjectIds,
    topics: record.topics,
    interpretation: record.derivedStatement,
    qualifications: record.qualifications,
    uncertainty: record.uncertainty,
    competingWith: [],
    kind: record.kind,
    sourceQuotes: record.directEvidence.flatMap((item) =>
      item.quoteSpans.map((quote) => ({ sourceId: item.sourceId, quote })),
    ),
    processingVersion: record.processingVersion,
  };
}

const databaseTest = (name, run) =>
  test(
    name,
    {
      skip:
        process.env.CHECK_DATABASE !== "1" ||
        !process.env.NW_OFFLINE_REVIEW_PACKAGE ||
        !process.env.NW_OFFLINE_CORRECTIONS,
    },
    async () => {
      assert.ok(
        process.env.NW_OFFLINE_REVIEW_PACKAGE,
        "set NW_OFFLINE_REVIEW_PACKAGE to the private v6 export",
      );
      assert.ok(
        process.env.NW_OFFLINE_CORRECTIONS,
        "set NW_OFFLINE_CORRECTIONS to the private proposal file",
      );
      const [review, proposal] = await Promise.all([
        readFile(process.env.NW_OFFLINE_REVIEW_PACKAGE, "utf8").then(JSON.parse),
        readFile(process.env.NW_OFFLINE_CORRECTIONS, "utf8").then(JSON.parse),
      ]);
      assert.equal(proposal.schemaVersion, "evaluator-authored-offline-corrections-v1");
      assert.match(proposal.authority, /not model output.*not.*live annotations/i);
      await withDatabase((db, knowledge) =>
        run({ db, knowledge, review, proposals: proposal.corrections }),
      );
    },
  );

databaseTest(
  "offline evaluator proposals revise four candidates, render mapped evidence, preserve history, and invalidate on source changes",
  async ({ db, knowledge, review, proposals }) => {
    const byId = new Map(review.reviewStatements.map((record) => [record.annotationId, record]));
    const proposalById = new Map(proposals.map((candidate) => [candidate.id, candidate]));
    assert.equal(proposals.length, 4);
    const selectedContextByAnnotation = new Map();
    const sourceById = new Map();
    for (const record of review.reviewStatements) {
      const selectedContextIds = new Set(
        proposalById.get(record.annotationId)?.contextSourceIds ?? [],
      );
      for (const item of record.directEvidence)
        if (
          item.replyTo &&
          record.contextualSources.some((context) => context.sourceId === item.replyTo)
        )
          selectedContextIds.add(item.replyTo);
      selectedContextByAnnotation.set(record.annotationId, [...selectedContextIds]);
      for (const item of record.directEvidence) sourceById.set(item.sourceId, toSource(item));
      for (const item of record.contextualSources) {
        if (selectedContextIds.has(item.sourceId)) sourceById.set(item.sourceId, toSource(item));
      }
    }
    for (const item of sourceById.values()) await knowledge.registerSource(item);

    const setupByAnnotation = new Map();
    for (const record of review.reviewStatements) {
      const candidate = candidateFromRecord(record);
      const correction = proposalById.get(record.annotationId);
      const directIds = [...candidate.sourceIds].sort((left, right) =>
        BigInt(left) < BigInt(right) ? -1 : 1,
      );
      const contextIds = selectedContextByAnnotation.get(record.annotationId) ?? [];
      const firstDirect = sourceById.get(directIds[0]);
      const manifestId = `offline-semantic-${setupByAnnotation.size}`;
      const episodeKey = "selected-case";
      const manifest = {
        id: manifestId,
        schemaVersion: "community-archive-manifest-v1",
        archiveConnectionId: "offline-v6-review",
        generation: 1,
        episodes: [
          {
            key: episodeKey,
            label: "Private evaluator-selected evidence",
            guildId: firstDirect.guildId,
            channelId: firstDirect.channelId,
            sourceIds: directIds,
            contextIds,
          },
        ],
      };
      await knowledge.installManifest(manifest);
      const initial = await knowledge.prepareAnnotation({ manifestId, episodeKey, candidate });
      assert.equal((await knowledge.commitAnnotation(initial)).disposition, "applied");
      setupByAnnotation.set(record.annotationId, { manifestId, episodeKey, record });
    }

    const economicsProposal = proposals.find((item) =>
      item.claims.some((claim) => claim.anchors.some((anchor) => anchor.relation === "qualifies")),
    );
    const economicsSetup = setupByAnnotation.get(economicsProposal.id);
    const badAttribution = structuredClone(economicsProposal);
    const originalAttribution = badAttribution.claims[0].anchors[0].attributedTo;
    badAttribution.claims[0].anchors[0].attributedTo = [...sourceById.values()].find(
      (source) => source.authorId !== originalAttribution,
    ).authorId;
    await assert.rejects(
      knowledge.prepareAnnotation({
        manifestId: economicsSetup.manifestId,
        episodeKey: economicsSetup.episodeKey,
        candidate: badAttribution,
      }),
      /source, attribution or context role/,
    );
    const unsupportedQuote = structuredClone(economicsProposal);
    unsupportedQuote.claims[0].anchors[0].quote += " (not present in source)";
    await assert.rejects(
      knowledge.prepareAnnotation({
        manifestId: economicsSetup.manifestId,
        episodeKey: economicsSetup.episodeKey,
        candidate: unsupportedQuote,
      }),
      /source, attribution or context role/,
    );

    for (const correction of proposals) {
      const setup = setupByAnnotation.get(correction.id);
      const prior = byId.get(correction.id);
      const value = { ...correction };
      const prepared = await knowledge.prepareAnnotation({
        manifestId: setup.manifestId,
        episodeKey: setup.episodeKey,
        candidate: value,
      });
      assert.equal((await knowledge.commitAnnotation(prepared)).disposition, "applied");
      const revisions = await db.query(
        "SELECT revision,status,candidate FROM pilot_knowledge_annotations WHERE id=$1 ORDER BY revision",
        [correction.id],
      );
      assert.equal(revisions.rows.length, 2);
      assert.equal(revisions.rows[0].status, "superseded");
      assert.equal(revisions.rows[0].candidate.interpretation, prior.derivedStatement);
      assert.equal(revisions.rows[1].status, "candidate");
      assert.equal(
        revisions.rows[1].candidate.processingVersion,
        "evaluator-authored-offline-proposal-v1",
      );
    }

    for (const correction of proposals) {
      const record = byId.get(correction.id);
      const topic = correction.topics[0];
      const profile = await knowledge.view("profile", correction.subjectIds[0]);
      const topical = await knowledge.view("topic", topic);
      const history = await knowledge.view("history", `${correction.subjectIds[0]}:${topic}`);
      for (const document of [profile, topical, history]) {
        const entry = document.entries.find((item) => item.annotationId === correction.id);
        assert.ok(entry, `${document.target} contains ${correction.id}`);
        assert.deepEqual(
          entry.claims.map((claim) => claim.id),
          correction.claims.map((claim) => claim.id),
        );
        assert.ok(entry.sources.length >= record.directEvidence.length);
        assert.match(
          renderKnowledgeView(document),
          /claim-level evidence maps appear only when recorded/i,
        );
      }
    }

    const outOfOrderHistories = review.historyViews.filter(
      (view) => !view.orderedByEarliestEvidenceTime,
    );
    assert.equal(outOfOrderHistories.length, 3);
    for (const expectedView of outOfOrderHistories) {
      const [memberId, topic] = expectedView.key.split(":");
      const expectedIds = review.reviewStatements
        .filter((record) => record.subjectIds.includes(memberId) && record.topics.includes(topic))
        .sort((left, right) => {
          const earliest = (record) =>
            Math.min(...record.directEvidence.map((item) => Date.parse(item.createdAt)));
          return (
            earliest(left) - earliest(right) || left.annotationId.localeCompare(right.annotationId)
          );
        })
        .map((record) => record.annotationId);
      const view = await knowledge.view("history", expectedView.key);
      assert.deepEqual(
        view.entries.map((entry) => entry.annotationId),
        expectedIds,
      );
    }

    const economics = economicsProposal;
    const economicsHistoryKey = `${economics.subjectIds[0]}:${economics.topics[0]}`;
    const economicsEntry = (await knowledge.view("history", economicsHistoryKey)).entries.find(
      (entry) => entry.annotationId === economics.id,
    );
    assert.match(
      renderKnowledgeView({
        target: "history",
        key: economicsHistoryKey,
        entries: [economicsEntry],
      }),
      new RegExp(
        `${economics.claims.find((claim) => claim.anchors.some((anchor) => anchor.relation === "qualifies")).id}.*qualifies:${economics.claims.find((claim) => claim.anchors.some((anchor) => anchor.relation === "qualifies")).anchors.find((anchor) => anchor.relation === "qualifies").attributedTo}`,
      ),
    );

    const conflicting = proposals.find((item) =>
      item.claims.some((claim) =>
        claim.anchors.some((anchor) => anchor.relation === "contradicts" && anchor.relatedClaimId),
      ),
    );
    const conflictAnchor = conflicting.claims
      .flatMap((claim) => claim.anchors)
      .find((anchor) => anchor.relation === "contradicts");
    const conflictingView = await knowledge.view(
      "history",
      `${conflicting.subjectIds[0]}:${conflicting.topics[0]}`,
    );
    const renderedConflict = renderKnowledgeView(conflictingView);
    assert.match(
      renderedConflict,
      new RegExp(
        `${conflictAnchor.relation}:${conflictAnchor.attributedTo}>${conflictAnchor.sourceId}`,
      ),
    );
    assert.match(renderedConflict, new RegExp(`~${conflictAnchor.relatedClaimId}`));
    assert.match(renderedConflict, new RegExp(conflictAnchor.sourceId));

    const contextual = proposals.find((item) =>
      item.claims.some((claim) => claim.anchors.some((anchor) => anchor.relation === "context")),
    );
    const dogEntry = (
      await knowledge.view("history", `${contextual.subjectIds[0]}:${contextual.topics[0]}`)
    ).entries.find((entry) => entry.annotationId === contextual.id);
    assert.ok(
      dogEntry.contextSources.some((item) => item.sourceId === contextual.contextSourceIds[0]),
    );
    assert.equal(dogEntry.sources[0].replyBoundary.status, "included-context");

    const unresolved = proposals.find((item) =>
      item.sourceIds.some((id) => {
        const parentId = sourceById.get(id).replyTo;
        return parentId && !selectedContextByAnnotation.get(item.id).includes(parentId);
      }),
    );
    const unresolvedEntry = (
      await knowledge.view("history", `${unresolved.subjectIds[0]}:${unresolved.topics[0]}`)
    ).entries.find((entry) => entry.annotationId === unresolved.id);
    assert.equal(unresolvedEntry.sources[0].replyBoundary.status, "outside-selected-slice");
    assert.match(
      renderKnowledgeView({
        target: "history",
        key: `${unresolved.subjectIds[0]}:${unresolved.topics[0]}`,
        entries: [unresolvedEntry],
      }),
      /reply parent outside selected evidence/,
    );

    const editedId = economics.sourceIds[0];
    const edited = {
      ...sourceById.get(editedId),
      content: sourceById.get(editedId).content + " [offline edit]",
    };
    await knowledge.registerSource(edited);
    const deletedId = conflicting.contextSourceIds[0];
    await knowledge.removeSource(deletedId);
    for (const id of [economics.id, conflicting.id]) {
      const status = await db.query(
        "SELECT status FROM pilot_knowledge_annotations WHERE id=$1 ORDER BY revision DESC LIMIT 1",
        [id],
      );
      assert.equal(status.rows[0].status, "invalidated");
      const original = await db.query(
        "SELECT status,candidate FROM pilot_knowledge_annotations WHERE id=$1 AND revision=1",
        [id],
      );
      assert.equal(original.rows[0].status, "superseded");
      assert.notEqual(
        original.rows[0].candidate.processingVersion,
        "evaluator-authored-offline-proposal-v1",
      );
    }
    for (const candidate of [economics, conflicting])
      assert.equal(
        (await knowledge.view("topic", candidate.topics[0])).entries.some(
          (entry) => entry.annotationId === candidate.id,
        ),
        false,
      );
  },
);
