import assert from "node:assert/strict";
import test from "node:test";

import {
  profileReviewBatch,
  reviewedProfilePositions,
  validateProfileReview,
} from "./member-profile-review.mjs";

const member = { id: "200000000000000001", name: "Ada", guildId: "100000000000000001" };
let sequence = 0;
function evidence(overrides = {}) {
  const n = ++sequence;
  return {
    statementId: `statement-${n}`,
    memberId: member.id,
    guildId: member.guildId,
    messageId: String(500000000000000000n + BigInt(n)),
    revisionId: `revision-${n}`,
    channelId: "300000000000000001",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    kind: "exact_quote",
    topic: "housing",
    proposition: "The city should allow more apartments",
    quote: "The city should allow more apartments",
    sourceContent: "The city should allow more apartments",
    extractorVersion: "fictional-extractor",
    freshness: "current",
    ...overrides,
  };
}

function decide(row, overrides = {}) {
  return {
    statementId: row.statementId,
    disposition: "position",
    concept: "housing-supply",
    claimKey: "permit-multifamily-housing",
    proposition: "Ada favors allowing more multifamily housing",
    direction: "support",
    qualifiers: [],
    conditions: [],
    sourceIds: [row.messageId],
    ...overrides,
  };
}

function reviewed(statements, choices) {
  const batch = profileReviewBatch({ member, statements });
  const result = validateProfileReview({
    batch,
    review: {
      batchToken: batch.batchToken,
      decisions: batch.statements.map((row, index) => decide(row, choices?.[index])),
    },
  });
  return { batch, ...result };
}

test("a leading conditional cannot be stored as an unqualified position", () => {
  const row = evidence({
    sourceContent: "If the toll were removed I would support the bridge",
    quote: "If the toll were removed I would support the bridge",
    proposition: "If the toll were removed I would support the bridge",
  });
  const batch = profileReviewBatch({ member, statements: [row] });
  assert.throws(
    () =>
      validateProfileReview({
        batch,
        review: { batchToken: batch.batchToken, decisions: [decide(row)] },
      }),
    /unqualified claim/,
  );
  const accepted = validateProfileReview({
    batch,
    review: {
      batchToken: batch.batchToken,
      decisions: [decide(row, { conditions: ["the toll is removed"] })],
    },
  });
  assert.deepEqual(accepted.records[0].conditions, ["the toll is removed"]);
  assert.match(batch.guidance, /pure counterfactual/i);

  const counterfactual = evidence({
    sourceContent: "If the party had won we'd have a much better world",
    quote: "If the party had won we'd have a much better world",
    proposition: "If the party had won we'd have a much better world",
  });
  const counterfactualBatch = profileReviewBatch({ member, statements: [counterfactual] });
  assert.throws(
    () =>
      validateProfileReview({
        batch: counterfactualBatch,
        review: {
          batchToken: counterfactualBatch.batchToken,
          decisions: [
            decide(counterfactual, {
              proposition: "If the party had won, the world would be much better",
              conditions: ["the party had won"],
            }),
          ],
        },
      }),
    /pure counterfactual/,
  );
  const withheld = validateProfileReview({
    batch: counterfactualBatch,
    review: {
      batchToken: counterfactualBatch.batchToken,
      decisions: [
        decide(counterfactual, {
          disposition: "uncertain",
          direction: "unspecified",
          concept: null,
          claimKey: null,
          proposition: null,
          conditions: ["the party had won"],
        }),
      ],
    },
  });
  assert.equal(withheld.records[0].disposition, "uncertain");
  assert.deepEqual(withheld.records[0].conditions, ["the party had won"]);
});

test("semantic paraphrases merge only under the reviewer's explicit claim identity", () => {
  const first = evidence();
  const second = evidence({
    topic: "urbanism",
    proposition: "Abolish rules limiting dwellings to a single family",
    quote: "Abolish rules limiting dwellings to a single family",
    sourceContent: "Abolish rules limiting dwellings to a single family",
  });
  const { records } = reviewed(
    [first, second],
    [{}, { proposition: "Ada wants restrictions on multifamily homes removed" }],
  );
  const result = reviewedProfilePositions({ statements: [first, second], reviews: records });
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].independentMessages, 2);
  assert.equal(result.positions[0].interpretation.kind, "model-proposed");
  assert.equal(result.positions[0].interpretation.meaningVerified, false);
  assert.equal(result.positions[0].evidence.length, 2);
  assert.equal(
    result.positions[0].interpretations[1].proposition,
    "Ada wants restrictions on multifamily homes removed",
  );
});

test("an important singleton is a first-class reviewed position", () => {
  const row = evidence({ sourceContent: "I will never support secret courts" });
  const { records } = reviewed(
    [row],
    [
      {
        concept: "due-process",
        claimKey: "secret-courts",
        direction: "oppose",
        proposition: "Ada opposes secret courts",
        exactQuote: "I will never support secret courts",
      },
    ],
  );
  const result = reviewedProfilePositions({ statements: [row], reviews: records });
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].independentMessages, 1);
  assert.equal(result.positions[0].interpretations[0].exactQuote, row.sourceContent);
});

test("unmarked sarcasm is classified by model judgment, not a marker dictionary", () => {
  const row = evidence({
    quote: "Perfect, another secret tribunal. Exactly what democracy needed.",
    sourceContent: "Perfect, another secret tribunal. Exactly what democracy needed.",
  });
  const { records } = reviewed(
    [row],
    [
      {
        disposition: "sarcasm",
        concept: null,
        claimKey: null,
        proposition: null,
        direction: "unspecified",
        rationale: "The praise is sarcastic; no literal endorsement is inferred.",
      },
    ],
  );
  const result = reviewedProfilePositions({ statements: [row], reviews: records });
  assert.deepEqual(result.positions, []);
  assert.equal(result.uncertainties[0].disposition, "sarcasm");
  assert.equal(result.coverage.reviewedStatements, 1);
});

test("opposition, conditions, and different meanings never merge through a shared topic", () => {
  const rows = Array.from({ length: 4 }, () => evidence());
  const { records } = reviewed(rows, [
    {},
    { direction: "oppose", proposition: "Ada opposes multifamily housing" },
    { conditions: ["Only if there is accessible transit"] },
    { claimKey: "rent-control", proposition: "Ada favors rent control" },
  ]);
  const { positions } = reviewedProfilePositions({ statements: rows, reviews: records });
  assert.equal(positions.length, 4);
  assert.ok(positions.some((position) => position.direction === "oppose"));
  assert.ok(
    positions.some((position) =>
      position.conditions.includes("Only if there is accessible transit"),
    ),
  );
});

test("no longer opposing is retained as withdrawal, never invented support", () => {
  const row = evidence({
    sourceContent: "I no longer oppose the levy, but I haven't decided whether I support it",
  });
  const { records } = reviewed(
    [row],
    [
      {
        disposition: "change",
        concept: "levy",
        claimKey: "levy",
        proposition: "Ada withdrew opposition without endorsing the levy",
        direction: "withdrawn",
        exactQuote: "I no longer oppose the levy",
      },
    ],
  );
  const result = reviewedProfilePositions({ statements: [row], reviews: records });
  assert.equal(result.positions.length, 0);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].direction, "withdrawn");
  assert.equal(result.changes[0].changeKind, "withdrawal");
  const batch = profileReviewBatch({ member, statements: [row] });
  assert.throws(
    () =>
      validateProfileReview({
        batch,
        review: {
          batchToken: batch.batchToken,
          decisions: [
            decide(batch.statements[0], {
              disposition: "change",
              direction: "support",
              changeKind: "withdrawal",
            }),
          ],
        },
      }),
    /not an inverse endorsement/,
  );
});

test("missing, duplicated, foreign, and stale batch dispositions are rejected", () => {
  const rows = [evidence(), evidence()];
  const batch = profileReviewBatch({ member, statements: rows });
  const decisions = batch.statements.map((row) => decide(row));
  assert.throws(
    () =>
      validateProfileReview({
        batch,
        review: {
          batchToken: "wrong",
          decisions,
        },
      }),
    /token mismatch/,
  );
  assert.throws(
    () =>
      validateProfileReview({
        batch,
        review: {
          batchToken: batch.batchToken,
          decisions: decisions.slice(0, 1),
        },
      }),
    /every batch statement/,
  );
  assert.throws(
    () =>
      validateProfileReview({
        batch,
        review: {
          batchToken: batch.batchToken,
          decisions: [decisions[0], decisions[0]],
        },
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateProfileReview({
        batch,
        review: {
          batchToken: batch.batchToken,
          decisions: [decisions[0], { ...decisions[1], statementId: "foreign" }],
        },
      }),
    /Foreign/,
  );
  const tampered = structuredClone(batch);
  tampered.statements[0].sourceContent = "Changed after packet creation";
  assert.throws(
    () =>
      validateProfileReview({
        batch: tampered,
        review: {
          batchToken: batch.batchToken,
          decisions,
        },
      }),
    /batch evidence/,
  );
});

test("foreign member and hidden source references cannot support a review", () => {
  const row = evidence();
  const hidden = evidence({ visible: false });
  const foreign = evidence({ memberId: "200000000000000002" });
  const batch = profileReviewBatch({ member, statements: [row, hidden, foreign] });
  assert.deepEqual(
    batch.statements.map((item) => item.statementId),
    [row.statementId],
  );
  assert.equal(batch.coverage.excludedStatements, 2);
  assert.throws(
    () =>
      validateProfileReview({
        batch,
        review: {
          batchToken: batch.batchToken,
          decisions: [
            decide(batch.statements[0], { sourceIds: [row.messageId, hidden.messageId] }),
          ],
        },
      }),
    /Foreign.*source/,
  );
  assert.throws(
    () =>
      validateProfileReview({
        batch,
        review: {
          batchToken: batch.batchToken,
          decisions: [
            decide(batch.statements[0], {
              evidenceStatementIds: [row.statementId, foreign.statementId],
            }),
          ],
        },
      }),
    /current batch/,
  );
  assert.throws(
    () => reviewedProfilePositions({ statements: [row, foreign], reviews: [] }),
    /mix members/,
  );
});

test("verbatim quotes preserve curly punctuation and source spelling", () => {
  const row = evidence({ sourceContent: "I don’t support guraranteed subsidies" });
  const batch = profileReviewBatch({ member, statements: [row] });
  const review = {
    batchToken: batch.batchToken,
    decisions: [
      decide(batch.statements[0], {
        exactQuote: "I don’t support guraranteed subsidies",
      }),
    ],
  };
  assert.equal(validateProfileReview({ batch, review }).records[0].exactQuote, row.sourceContent);
  review.decisions[0].exactQuote = "I don't support guaranteed subsidies";
  assert.throws(() => validateProfileReview({ batch, review }), /not verbatim/);
});

test("changed source bytes, chronology, revisions, and hidden evidence invalidate existing reviews", () => {
  const row = evidence();
  const { records } = reviewed([row]);
  assert.equal(
    profileReviewBatch({ member, statements: [row], reviews: records }).statements.length,
    0,
  );
  for (const change of [
    { sourceContent: "This original was edited" },
    { occurredAt: "2026-06-01T00:00:00.000Z" },
    { revisionId: "new-revision" },
  ]) {
    const changed = { ...row, ...change };
    const batch = profileReviewBatch({ member, statements: [changed], reviews: records });
    assert.equal(batch.statements.length, 1);
    assert.equal(
      reviewedProfilePositions({ statements: [changed], reviews: records }).positions.length,
      0,
    );
  }
  for (const change of [
    { visible: false },
    { freshness: "edited" },
    { invalidated: true },
    { deletedAt: "2026-06-01" },
  ]) {
    const changed = { ...row, ...change };
    assert.equal(
      profileReviewBatch({ member, statements: [changed], reviews: records }).statements.length,
      0,
    );
    assert.equal(
      reviewedProfilePositions({ statements: [changed], reviews: records }).positions.length,
      0,
    );
  }
});

test("a review depending on another statement expires when that evidence is hidden", () => {
  const rows = [evidence(), evidence()];
  const batch = profileReviewBatch({ member, statements: rows });
  const { records } = validateProfileReview({
    batch,
    review: {
      batchToken: batch.batchToken,
      decisions: batch.statements.map((row) =>
        decide(row, {
          evidenceStatementIds: rows.map((item) => item.statementId),
          sourceIds: rows.map((item) => item.messageId),
        }),
      ),
    },
  });
  const filtered = [rows[0]];
  assert.equal(
    reviewedProfilePositions({ statements: filtered, reviews: records }).positions.length,
    0,
  );
  assert.equal(
    profileReviewBatch({ member, statements: filtered, reviews: records }).statements.length,
    1,
  );
});

test("multiple extractors of one original count as one supporting message", () => {
  const first = evidence();
  const second = evidence({
    messageId: first.messageId,
    revisionId: first.revisionId,
    extractorVersion: "other-extractor",
  });
  const { records } = reviewed([first, second]);
  const result = reviewedProfilePositions({ statements: [first, second], reviews: records });
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].independentMessages, 1);
  assert.equal(result.positions[0].statementCount, 2);
});

test("bounded packets are deterministic, preserve full originals, and resume after explicit no-position", () => {
  const rows = [evidence(), evidence(), evidence()];
  const first = profileReviewBatch({
    member,
    statements: rows.slice().reverse(),
    maxStatements: 2,
  });
  assert.deepEqual(
    first.statements.map((item) => item.statementId),
    rows.slice(0, 2).map((item) => item.statementId),
  );
  assert.equal(first.coverage.pendingStatements, 3);
  assert.equal(first.coverage.remainingAfterBatch, 1);
  assert.equal(first.statements[0].sourceContent, rows[0].sourceContent);
  assert.equal(
    first.batchToken,
    profileReviewBatch({ member, statements: rows, maxStatements: 2 }).batchToken,
  );
  const { records } = validateProfileReview({
    batch: first,
    review: {
      batchToken: first.batchToken,
      decisions: first.statements.map((row) =>
        decide(row, {
          disposition: "no-position",
          concept: null,
          claimKey: null,
          proposition: null,
        }),
      ),
    },
  });
  const next = profileReviewBatch({ member, statements: rows, reviews: records });
  assert.deepEqual(
    next.statements.map((item) => item.statementId),
    [rows[2].statementId],
  );
  assert.equal(next.coverage.reviewedStatements, 2);
  assert.equal(next.coverage.corpusComplete, false);
  const empty = profileReviewBatch({ member, statements: [] });
  assert.equal(empty.coverage.reviewState, "no-evidence");
  assert.equal(empty.coverage.availableEvidenceReviewed, false);
  assert.equal(empty.coverage.extractionReviewCoverage, "unknown");
});

test("oversized source originals remain pending rather than being silently truncated", () => {
  const row = evidence({ sourceContent: "x".repeat(20000) });
  const batch = profileReviewBatch({ member, statements: [row], maxCharacters: 16000 });
  assert.equal(batch.statements.length, 0);
  assert.equal(batch.coverage.pendingStatements, 1);
  assert.equal(batch.blocked[0].statementId, row.statementId);
  assert.equal(batch.blocked[0].reason, "original-exceeds-budget");
  const larger = profileReviewBatch({ member, statements: [row], maxCharacters: 24000 });
  assert.equal(larger.statements[0].sourceContent.length, 20000);
  assert.ok(larger.coverage.evidenceCharacters <= 24000);
});

test("source context must be explicitly visible and current and is fingerprinted", () => {
  const row = evidence({
    sourceContext: [
      {
        messageId: "context-a",
        revisionId: "context-rev",
        memberId: member.id,
        visible: true,
        freshness: "current",
        content: "This was a hypothetical",
      },
      {
        messageId: "context-hidden",
        revisionId: "context-rev-2",
        visible: false,
        freshness: "current",
        content: "Must never reach the model",
      },
    ],
  });
  const { batch, records } = reviewed([row]);
  assert.equal(batch.statements[0].sourceContext.length, 1);
  assert.equal(batch.statements[0].sourceContext[0].content, "This was a hypothetical");
  assert.equal(JSON.stringify(batch).includes("Must never reach"), false);
  const changed = { ...row, sourceContext: [] };
  assert.equal(
    profileReviewBatch({ member, statements: [changed], reviews: records }).statements.length,
    1,
  );
});

test("the model cannot supply member scope or undeclared interpretation fields", () => {
  const row = evidence();
  const batch = profileReviewBatch({ member, statements: [row] });
  assert.throws(
    () =>
      validateProfileReview({
        batch,
        review: {
          batchToken: batch.batchToken,
          decisions: [decide(batch.statements[0], { memberId: "another-member" })],
        },
      }),
    /decision fields/,
  );
  assert.throws(
    () =>
      validateProfileReview({
        batch,
        review: {
          batchToken: batch.batchToken,
          visibleChannelIds: ["secret-channel"],
          decisions: [decide(batch.statements[0])],
        },
      }),
    /response fields/,
  );
});

test("review records cannot be silently selected by array order when meanings conflict", () => {
  const row = evidence();
  const { records } = reviewed([row]);
  const changedMeaning = { ...records[0], direction: "oppose" };
  assert.throws(
    () => profileReviewBatch({ member, statements: [row], reviews: [...records, changedMeaning] }),
    /Conflicting current profile reviews/,
  );
});

test("a current batch cannot be mutated into hidden or invalidated evidence", () => {
  const row = evidence();
  const original = profileReviewBatch({ member, statements: [row] });
  for (const change of [{ hidden: true }, { invalidated: true }, { freshness: "edited" }]) {
    const batch = structuredClone(original);
    Object.assign(batch.statements[0], change);
    assert.throws(
      () =>
        validateProfileReview({
          batch,
          review: {
            batchToken: batch.batchToken,
            decisions: [decide(batch.statements[0])],
          },
        }),
      /batch evidence/,
    );
  }
});
