import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReviewPackage } from "./community-knowledge-review-package.mjs";

const sourceId = "555555555555555501";
const contextId = "555555555555555502";
const authorId = "333333333333333333";
const source = (sourceId, exactMessage, replyTo = null) => ({
  sourceId,
  sourceRevision: 4,
  sourceGeneration: 2,
  sourceDigest: `digest-${sourceId}`,
  status: "current",
  authorId,
  authorName: "Synthetic reviewer",
  createdAt: "2026-10-19T12:00:00.000Z",
  replyTo,
  canonicalPermalink: `https://discord.com/channels/111111111111111111/222222222222222222/${sourceId}`,
  exactMessage,
});

test("review package keeps each interpretation beside its evidence, boundary, and review gaps", () => {
  const review = buildReviewPackage({
    generatedAt: "2026-10-19T12:00:00.000Z",
    sources: [
      source(sourceId, "I prefer the train for this trip.", contextId),
      source(contextId, "The weather is clear."),
    ],
    annotations: [
      {
        annotationId: "trip-preference",
        revision: 2,
        candidateDigest: "candidate-digest",
        manifestId: "synthetic-review",
        manifestGeneration: 3,
        episodeId: "synthetic-review:trip",
        createdAt: "2026-10-19T12:00:00.000Z",
        episode: {
          key: "trip",
          label: "Synthetic trip",
          sourceIds: [sourceId],
          contextIds: [contextId],
        },
        candidate: {
          id: "trip-preference",
          sourceIds: [sourceId],
          sourceQuotes: [
            { sourceId, quote: "I prefer the train" },
            { sourceId, quote: "for this trip" },
          ],
          subjectIds: [authorId],
          topics: ["trip"],
          interpretation: "The speaker prefers the train for this trip.",
          qualifications: [
            "Topic label is the founder-selected manifest episode key; inspect the cited sources.",
          ],
          uncertainty: "unknown",
          competingWith: ["other-reading"],
          processingVersion: "synthetic-v1",
        },
      },
    ],
    priors: [
      {
        annotationId: "trip-preference",
        revision: 1,
        status: "superseded",
        interpretation: "The speaker always prefers the train.",
        sourceIds: [sourceId],
        createdAt: "2026-10-18T12:00:00.000Z",
      },
    ],
    competitors: [],
    views: [
      {
        target: "history",
        key: `${authorId}:trip`,
        revision: 7,
        documentDigest: "view-digest",
        document: {
          entries: [
            {
              annotationId: "trip-preference",
              annotationRevision: 2,
              interpretation: "The speaker prefers the train for this trip.",
              createdAt: "2026-10-19T12:00:00.000Z",
              sources: [{ sourceId, createdAt: "2026-10-19T12:00:00.000Z" }],
            },
          ],
        },
      },
    ],
  });
  const statement = review.reviewStatements[0];
  assert.equal(statement.directEvidence[0].canonicalPermalink.endsWith(sourceId), true);
  assert.equal(statement.directEvidence[0].exactMessage, "I prefer the train for this trip.");
  assert.deepEqual(statement.directEvidence[0].quoteSpans, ["I prefer the train", "for this trip"]);
  assert.deepEqual(statement.directEvidence[0].replyBoundary, {
    status: "included",
    sourceId: contextId,
    sourceRevision: 4,
    sourceGeneration: 2,
    sourceDigest: `digest-${contextId}`,
    sourceStatus: "current",
    createdAt: "2026-10-19T12:00:00.000Z",
    canonicalPermalink: `https://discord.com/channels/111111111111111111/222222222222222222/${contextId}`,
  });
  assert.deepEqual(statement.episode.contextBoundary[0], {
    sourceId: contextId,
    sourceRevision: 4,
    sourceGeneration: 2,
    sourceDigest: `digest-${contextId}`,
    status: "current",
    createdAt: "2026-10-19T12:00:00.000Z",
    canonicalPermalink: `https://discord.com/channels/111111111111111111/222222222222222222/${contextId}`,
  });
  assert.equal(statement.contextualSources[0].exactMessage, "The weather is clear.");
  assert.equal(statement.contextualSources[0].relationshipToAnnotation, "selected-episode-context");
  assert.deepEqual(statement.viewLineage, [
    {
      target: "history",
      key: `${authorId}:trip`,
      revision: 7,
      documentDigest: "view-digest",
      annotationRevisionStatus: "present",
      renderedInterpretation: "The speaker prefers the train for this trip.",
    },
  ]);
  assert.equal(review.historyViews[0].orderedByEarliestEvidenceTime, true);
  assert.deepEqual(review.historyViews[0].storedEntryOrder[0].sourceTimeOrder, [
    { sourceId, createdAt: "2026-10-19T12:00:00.000Z" },
  ]);
  assert.deepEqual(statement.replyDependencies, [
    {
      childSourceId: sourceId,
      parentSourceId: contextId,
      boundary: "included",
      dependencyRecordedOnAnnotation: false,
      interpretationDependency:
        "not-recorded; review whether this parent is needed to resolve the statement",
    },
  ]);
  assert.equal(statement.manifestGeneration, 3);
  assert.equal(statement.candidateDigest, "candidate-digest");
  assert.equal(statement.annotationStatus, "candidate");
  assert.equal(statement.priorAndSupersededInterpretations[0].status, "superseded");
  assert.deepEqual(statement.competingInterpretations, [
    { annotationId: "other-reading", status: "missing" },
  ]);
  assert.deepEqual(statement.semanticFlags, {
    fallbackTopicLabel: true,
    unknownUncertainty: true,
    noCompetingLinks: false,
  });
  assert.equal(review.semanticAudit.missingCompetingReferences, 1);
  assert.equal(review.currentness.allCurrentDirectEvidence, true);
});
