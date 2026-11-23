import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleProfile,
  classifyStatement,
  evidenceDigest,
  presentProfile,
  resolveNameCandidates,
} from "./member-profile.mjs";

const channel = "300000000000000001";
let sequence = 0;

function statement(overrides = {}) {
  sequence += 1;
  const id = String(500000000000000000n + BigInt(sequence));
  return {
    statementId: id,
    messageId: id,
    revisionId: id,
    channelId: channel,
    occurredAt: `2026-01-${String((sequence % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
    extractorVersion: "v2-profile-extraction-fixture",
    factIdentity: `fact-${id}`,
    kind: "exact_quote",
    topic: "levy",
    proposition: "I support the levy",
    quote: "I support the levy",
    assertion: null,
    freshness: "current",
    ...overrides,
  };
}

function profile(statements, extras = {}) {
  return assembleProfile({
    member: { id: "200000000000000001", name: "Ada" },
    statements,
    ...extras,
  });
}

test("a sparse member stays limited to the statement that exists", () => {
  const result = profile([statement()]);
  assert.equal(result.coverage.statementsConsidered, 1);
  assert.equal(result.selfDescriptionCount, 0);
  assert.equal(result.topics[0].positions.length, 1);
  assert.equal(result.topics[0].positions[0].representative.copiedFromStatement, true);
  assert.equal(result.topics[0].positions[0].interpretation, null);
  assert.equal(JSON.stringify(result).includes("biography"), false);
});

test("independent claims in one message survive, including two claims on the same topic", () => {
  const shared = "500000000000009991";
  const result = profile([
    statement({
      messageId: shared,
      quote: "I support the levy",
      proposition: "I support the levy",
    }),
    statement({
      messageId: shared,
      quote: "I oppose the harbor",
      proposition: "I oppose the harbor",
    }),
    statement({
      messageId: shared,
      topic: "transport",
      quote: "Buses need dedicated lanes",
      proposition: "Buses need dedicated lanes",
    }),
  ]);
  assert.equal(result.coverage.positionsConsidered, 3);
  assert.equal(result.coverage.messagesConsidered, 1);
  assert.equal(result.uncertaintyKinds["extractor-disagreement"], undefined);
});

test("withdrawing opposition does not establish support", () => {
  const decision = classifyStatement(statement({ quote: "I no longer oppose the levy" }));
  assert.equal(decision.currentPolarity, "withdrawn");
  assert.equal(decision.literalEndorsement, false);
  assert.notEqual(
    classifyStatement(statement({ quote: "I don't support the levy" })).polarity,
    "oppose",
  );
});

test("invalidated, older, or stale corrections cannot retire newer current evidence", () => {
  const current = statement({ occurredAt: "2026-06-01T00:00:00.000Z" });
  for (const freshness of ["current", "invalidated", "edited", "deleted"]) {
    const earlier = statement({
      quote: "I no longer support the levy",
      proposition: "I no longer support the levy",
      freshness,
      occurredAt: "2025-01-01T00:00:00.000Z",
    });
    const result = profile([current, earlier]);
    assert.equal(result.changeCount, 0, freshness);
    assert.equal(
      result.topics
        .flatMap((topic) => topic.positions)
        .some((position) => position.status === "current"),
      true,
    );
  }
});

test("changed chronology and original context change the maintenance fingerprint", () => {
  const row = statement();
  assert.notEqual(
    evidenceDigest([row]),
    evidenceDigest([{ ...row, occurredAt: "2027-01-01T00:00:00.000Z" }]),
  );
  assert.notEqual(
    evidenceDigest([row]),
    evidenceDigest([{ ...row, sourceContent: "I support the levy /s" }]),
  );
  assert.equal(
    classifyStatement({ ...row, sourceContent: "I support the levy /s" }).literalEndorsement,
    false,
  );
});

test("a busy topic keeps a one-off position in the overview beside repeated claims", () => {
  const repeated = Array.from({ length: 20 }, () => statement());
  const once = statement({
    quote: "I oppose closing the public library",
    proposition: "I oppose closing the public library",
    occurredAt: "2027-01-01T00:00:00.000Z",
  });
  const result = profile([...repeated, once]);
  assert.equal(
    result.topics[0].positions.some(
      (position) => position.representative.messageId === once.messageId,
    ),
    true,
  );
  assert.equal(
    result.topics[0].positions.some((position) => position.independentMessages === 20),
    true,
  );
});

test("deleted and invalidated originals are not returned as quote or self-description text", () => {
  const removed = statement({
    quote: "I am a private investigator",
    proposition: "I am a private investigator",
    freshness: "deleted",
  });
  const overview = profile([removed]);
  assert.equal(overview.selfDescriptionCount, 0);
  const detail = profile([removed], { view: "evidence", statementId: removed.statementId });
  assert.equal(detail.evidence[0].quote, null);
  assert.equal(detail.evidence[0].proposition, null);
  assert.equal(detail.evidence[0].contentWithheld, true);
});

test("large topics retain near-duplicate matching instead of disabling it above 400 groups", () => {
  const rows = Array.from({ length: 401 }, (_, index) =>
    statement({
      quote: `I support district${index} transit planning`,
      proposition: `I support district${index} transit planning`,
    }),
  );
  rows.push(
    statement({
      quote: "I support public housing construction",
      proposition: "I support public housing construction",
    }),
  );
  rows.push(
    statement({
      quote: "I strongly support public housing construction",
      proposition: "I strongly support public housing construction",
    }),
  );
  const result = profile(rows);
  assert.equal(result.coverage.positionsConsidered, 402);
  assert.equal(result.coverage.clustering, "near-duplicate");
});

test("original wording restores qualifications omitted by an extraction snippet", () => {
  const sourceContent = "I support the levy only if the accounts are public.";
  const decision = classifyStatement(statement({ quote: "I support the levy", sourceContent }));
  assert.match(decision.qualifier, /if the accounts are public/);
  const quoted = classifyStatement(
    statement({
      quote: "I support the levy",
      sourceContent: 'They said, "I support the levy". I disagree.',
    }),
  );
  assert.equal(quoted.role, "quotation");
  assert.equal(quoted.literalEndorsement, false);
});

test("an explicitly stated replacement is different from merely withdrawing opposition", () => {
  const decision = classifyStatement(
    statement({ quote: "I no longer oppose the levy but now support it" }),
  );
  assert.equal(decision.pastPolarity, "oppose");
  assert.equal(decision.currentPolarity, "support");
  assert.equal(decision.literalEndorsement, true);
});

test("a dated withdrawal does not erase a later re-expression of the earlier position", () => {
  const result = profile([
    statement({ occurredAt: "2024-01-01T00:00:00.000Z" }),
    statement({
      quote: "I no longer support the levy",
      proposition: "I no longer support the levy",
      occurredAt: "2025-01-01T00:00:00.000Z",
    }),
    statement({ occurredAt: "2026-01-01T00:00:00.000Z" }),
  ]);
  assert.equal(result.changeCount, 1);
  assert.equal(result.changes[0].expressedAgainLater, true);
  assert.equal(
    result.topics
      .flatMap((topic) => topic.positions)
      .some((position) => position.status === "current"),
    true,
  );
});

test("reply-parent changes and changed evidence invalidate maintenance and page cursors", () => {
  const row = statement({ sourceContext: [{ messageId: "parent", content: "First wording" }] });
  assert.notEqual(
    evidenceDigest([row]),
    evidenceDigest([
      { ...row, sourceContext: [{ messageId: "parent", content: "Edited wording" }] },
    ]),
  );
  const rows = Array.from({ length: 9 }, (_, index) =>
    statement({ topic: `subject topic${index}` }),
  );
  const first = profile(rows);
  assert.ok(first.page.nextCursor);
  assert.throws(
    () =>
      profile([{ ...rows[0], occurredAt: "2027-01-01T00:00:00.000Z" }, ...rows.slice(1)], {
        cursor: first.page.nextCursor,
      }),
    /cursor/,
  );
});

test("sarcasm, quotation, hypotheticals, and third-party descriptions are not endorsements", () => {
  const result = profile([
    statement({ quote: "I support the levy /s", proposition: "I support the levy /s" }),
    statement({
      quote: "According to Ada, the levy is necessary",
      proposition: "According to Ada, the levy is necessary",
    }),
    statement({ quote: "Suppose the levy were free", proposition: "Suppose the levy were free" }),
    statement({ quote: "They support the levy", proposition: "They support the levy" }),
  ]);
  assert.equal(result.topics.flatMap((topic) => topic.positions).length, 0);
  for (const kind of ["sarcasm", "quotation", "hypothetical", "third-party"]) {
    const found = result.uncertainties.find((item) => item.kind === kind);
    assert.ok(found, kind);
    assert.equal(found.literalEndorsement, false);
    assert.equal(found.intendedPosition, null);
  }
});

test("a conditional disagreement is not a contradiction, and an explicit change does not delete the earlier statement", () => {
  const support = statement({
    quote: "I support the levy",
    proposition: "I support the levy",
    occurredAt: "2026-01-01T00:00:00.000Z",
  });
  const conditional = statement({
    quote: "I support the levy if the city publishes the budget",
    proposition: "I support the levy if the city publishes the budget",
    occurredAt: "2026-02-01T00:00:00.000Z",
  });
  const oppose = statement({
    quote: "I oppose the levy",
    proposition: "I oppose the levy",
    occurredAt: "2026-03-01T00:00:00.000Z",
  });
  const mixed = profile([conditional, oppose]);
  assert.equal(mixed.conflictCount, 0);
  assert.equal(mixed.contextDependentCount, 1);
  assert.equal(mixed.topics.flatMap((topic) => topic.positions).length, 2);

  const changed = statement({
    quote: "I no longer support the levy",
    proposition: "I no longer support the levy",
    occurredAt: "2026-04-01T00:00:00.000Z",
  });
  const result = profile([support, changed]);
  assert.equal(result.changeCount, 1);
  assert.equal(result.changes[0].kind, "explicit-change");
  assert.equal(result.audit.statementIds.includes(support.statementId), true);
  assert.equal(
    result.topics.flatMap((topic) => topic.positions).some((item) => item.status === "former"),
    false,
  );
});

test("an explicit change of mind keeps the earlier statement", () => {
  const support = statement({
    quote: "I support the levy",
    proposition: "I support the levy",
    occurredAt: "2026-01-01T00:00:00.000Z",
  });
  const changed = statement({
    quote: "I've changed my mind and now I oppose the levy",
    proposition: "I've changed my mind and now I oppose the levy",
    occurredAt: "2026-04-01T00:00:00.000Z",
  });
  const result = profile([support, changed]);
  assert.equal(result.changeCount, 1);
  assert.equal(result.changes[0].currentPolarity, "oppose");
  assert.equal(result.audit.statementIds.includes(support.statementId), true);
  assert.equal(
    result.topics.flatMap((topic) => topic.positions).some((item) => item.status === "former"),
    false,
  );
});

test("a change of mind without a new position does not erase the earlier one", () => {
  const support = statement({
    quote: "I support the levy",
    proposition: "I support the levy",
    occurredAt: "2026-01-01T00:00:00.000Z",
  });
  const changed = statement({
    quote: "I have changed my mind about the levy",
    proposition: "I have changed my mind about the levy",
    occurredAt: "2026-04-01T00:00:00.000Z",
  });
  const result = profile([support, changed]);
  assert.equal(result.changeCount, 0);
  assert.equal(result.topics.flatMap((topic) => topic.positions).length, 1);
  assert.equal(
    result.uncertainties.some((item) => item.kind === "change-of-mind"),
    true,
  );
});

test("saying a view used to be held does not retire a current statement", () => {
  const support = statement({ quote: "I support the levy", proposition: "I support the levy" });
  const past = statement({
    quote: "I used to support the levy",
    proposition: "I used to support the levy",
    occurredAt: "2026-05-01T00:00:00.000Z",
  });
  const result = profile([support, past]);
  assert.equal(result.changeCount, 0);
  assert.equal(result.topics.flatMap((topic) => topic.positions).length, 1);
  assert.equal(
    result.uncertainties.some((item) => item.kind === "change-of-mind"),
    true,
  );
});

test("the member's denial keeps the earlier statement, and another person's words are a separate profile", () => {
  const support = statement({ quote: "I support the levy", proposition: "I support the levy" });
  const denial = statement({
    quote: "That is not my position",
    proposition: "That is not my position",
    topic: "levy",
    occurredAt: "2026-06-01T00:00:00.000Z",
  });
  const result = profile([support, denial]);
  const position = result.topics.flatMap((topic) => topic.positions)[0];
  assert.equal(position.speakerDisputed, true);
  assert.equal(result.audit.statementIds.includes(support.statementId), true);
  const other = profile(
    [
      statement({
        quote: "They support the levy",
        proposition: "They support the levy",
        topic: "levy",
      }),
    ],
    { member: { id: "200000000000000002", name: "Bea" } },
  );
  assert.equal(other.topics.flatMap((topic) => topic.positions).length, 0);
  assert.equal(JSON.stringify(other).includes("200000000000000001"), false);
});

test("a vague denial does not mark every position disputed", () => {
  const result = profile([
    statement({ topic: "levy", quote: "I support the levy", proposition: "I support the levy" }),
    statement({
      topic: "levy",
      quote: "I support the harbor",
      proposition: "I support the harbor",
    }),
    statement({
      topic: "levy",
      quote: "That is not my position",
      proposition: "That is not my position",
    }),
  ]);
  assert.equal(
    result.topics
      .flatMap((topic) => topic.positions)
      .every((item) => item.speakerDisputed === false),
    true,
  );
  assert.match(
    result.uncertainties.find((item) => item.kind === "attribution-correction").note,
    /does not identify/,
  );
});

test("repeated extractors are one message, and opposite extractors are not confirmation", () => {
  const messageId = "500000000000000099";
  const repeated = profile([
    statement({
      messageId,
      statementId: "500000000000000091",
      revisionId: "shared-current-revision",
      extractorVersion: "v2-profile-extraction-v1",
      factIdentity: "legacy-formula-a",
      quote: "I support public housing construction",
      proposition: "I support public housing construction",
    }),
    statement({
      messageId,
      statementId: "500000000000000092",
      revisionId: "shared-current-revision",
      extractorVersion: "v2-profile-extraction-grok-v1",
      factIdentity: "other-formula-b",
      quote: "I support public housing construction",
      proposition: "I support public housing construction",
    }),
  ]);
  const position = repeated.topics[0].positions[0];
  assert.equal(position.independentMessages, 1);
  assert.equal(position.statementCount, 2);
  assert.equal(position.duplicateExtractionsAreNotExtraEvidence, true);
  assert.deepEqual(position.extractorVersions, [
    "v2-profile-extraction-grok-v1",
    "v2-profile-extraction-v1",
  ]);
  assert.deepEqual(position.evidence[0].factIdentities, ["legacy-formula-a", "other-formula-b"]);

  const disagreed = profile([
    statement({
      messageId: "500000000000000098",
      revisionId: "shared-disputed-revision",
      extractorVersion: "extractor-a",
      quote: "I support the levy",
      proposition: "I support the levy",
    }),
    statement({
      messageId: "500000000000000098",
      revisionId: "shared-disputed-revision",
      extractorVersion: "extractor-b",
      quote: "I oppose the levy",
      proposition: "I oppose the levy",
    }),
  ]);
  assert.equal(disagreed.topics.flatMap((topic) => topic.positions).length, 0);
  assert.equal(disagreed.uncertainties[0].kind, "extractor-disagreement");
  assert.equal(disagreed.coverage.statementsConsidered, 2);
});

test("near-duplicate propositions stay linked without becoming one source", () => {
  const result = profile([
    statement({
      topic: "housing",
      quote: "I support public housing construction",
      proposition: "I support public housing construction",
    }),
    statement({
      topic: "housing",
      quote: "I support public housing construction projects",
      proposition: "I support public housing construction projects",
    }),
  ]);
  assert.equal(result.topics[0].positions.length, 1);
  assert.equal(result.topics[0].positions[0].independentMessages, 2);
});

test("an edited or deleted source is not a current position", () => {
  const edited = profile([
    statement({
      freshness: "edited",
      quote: "I support the levy",
      proposition: "I support the levy",
    }),
  ]);
  assert.equal(edited.topics.flatMap((topic) => topic.positions).length, 0);
  const detail = assembleProfile({
    member: { id: "200000000000000001", name: "Ada" },
    statements: [
      statement({
        freshness: "deleted",
        quote: "I support the levy",
        proposition: "I support the levy",
      }),
    ],
    view: "topic",
    topic: "levy",
  });
  assert.equal(detail.positions[0].status, "historical");
  assert.equal(detail.positions[0].evidence[0].freshness, "deleted");
});

test("a knowledge-correction command does not remove a position", () => {
  const support = statement({ quote: "I support the levy", proposition: "I support the levy" });
  const command = statement({
    quote: "!knowledge correct the levy",
    proposition: "!knowledge correct the levy",
  });
  const result = profile([support, command]);
  assert.equal(result.topics.flatMap((topic) => topic.positions).length, 1);
  assert.equal(
    result.uncertainties.some((item) => item.kind === "control-command"),
    true,
  );
  assert.equal(result.limitations.conversationalCorrection.includes("!knowledge correct"), true);
});

test("overview pages a prolific member without dropping the statement the old sample skipped", () => {
  const rows = Array.from({ length: 50 }, (_, index) =>
    statement({
      topic: `plan${index}`,
      quote: `I support plan ${index}`,
      proposition: `I support plan ${index}`,
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }),
  );
  rows.sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.statementId.localeCompare(right.statementId),
  );
  const total = rows.length;
  const stride = Math.max(Math.floor(total / 24), 1);
  const sampled = new Set(
    rows
      .filter((_, index) => {
        const rn = index + 1;
        return rn === 1 || rn === total || rn % stride === 0;
      })
      .slice(0, 24)
      .map((row) => row.statementId),
  );
  const omitted = rows.find((row) => !sampled.has(row.statementId));
  const result = profile(rows);
  assert.equal(result.coverage.statementsConsidered, 50);
  assert.equal(result.coverage.topicsConsidered, 50);
  assert.equal(result.page.returned < result.page.total, true);
  assert.equal(result.audit.statementIds.includes(omitted.statementId), true);
  assert.equal(JSON.stringify(presentProfile(result)).includes("audit"), false);
  const evidence = assembleProfile({
    member: { id: "200000000000000001", name: "Ada" },
    statements: rows,
    view: "evidence",
    statementId: omitted.statementId,
  });
  assert.equal(evidence.found, true);
  assert.equal(evidence.evidence[0].statementIds.includes(omitted.statementId), true);
  assert.equal(result.coverage.extractionReviewCoverage, "unknown");
  assert.equal(JSON.stringify(result).includes("completenessPercent"), false);
});

test("renamed members stay distinct when a current name collides with an old one", () => {
  const sightings = [
    { id: "200000000000000001", name: "Ada", seenAt: "2026-01-01T00:00:00.000Z" },
    { id: "200000000000000001", name: "Bo", seenAt: "2026-02-01T00:00:00.000Z" },
    { id: "200000000000000002", name: "Bo", seenAt: "2026-03-01T00:00:00.000Z" },
  ];
  const ambiguous = resolveNameCandidates("Bo", sightings);
  assert.equal(ambiguous.scope, "ambiguous");
  assert.deepEqual(
    ambiguous.members.map((member) => member.id),
    ["200000000000000001", "200000000000000002"],
  );
  assert.equal(ambiguous.members[0].name, "Bo");
  const unique = resolveNameCandidates("Ada", [sightings[0], sightings[1]]);
  assert.equal(unique.scope, "resolved");
  assert.equal(unique.member.id, "200000000000000001");
  assert.equal(unique.member.name, "Bo");
});
