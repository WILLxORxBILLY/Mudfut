import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { state } from "./runtime.mjs";
import {
  annotationsFromUnderstanding,
  communityKnowledge,
  communityKnowledgeStatus,
  correctionRouteAllowed,
  manifestDigest,
  parseKnowledgeCommand,
  renderKnowledgeView,
  retrieveCurrentKnowledgeView,
  validateArchiveManifest,
  validateAnnotation,
  validateKnowledgeViewQuery,
} from "./community-knowledge.mjs";

const guildId = "111111111111111111";
const channelId = "222222222222222222";
const authorId = "333333333333333333";
const sourceId = "555555555555555501";
const contextId = "555555555555555502";
const manifest = {
  id: "community-review-1",
  schemaVersion: "community-archive-manifest-v1",
  archiveConnectionId: "local-history-reader",
  generation: 1,
  episodes: [
    {
      key: "first-discussion",
      label: "Synthetic community discussion",
      guildId,
      channelId,
      sourceIds: [sourceId],
      contextIds: [contextId],
    },
  ],
};
const source = (id, content) => ({
  id,
  guildId,
  channelId,
  authorId,
  authorName: "Fixture Member",
  content,
  createdAt: "2026-10-16T12:00:00.000Z",
  editedAt: null,
  replyTo: null,
  url: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
});
const annotation = (overrides = {}) => ({
  id: "fixture-position",
  sourceIds: [sourceId],
  subjectIds: [authorId],
  topics: ["public-transit"],
  interpretation: "The speaker prefers taking the train for this trip.",
  qualifications: ["The statement concerns this trip, not every commute."],
  uncertainty: "low",
  competingWith: [],
  processingVersion: "fixture-v1",
  ...overrides,
});

test("community manifests, loose annotations, and Discord command grammar are strict and canonical", async () => {
  assert.deepEqual(validateArchiveManifest(manifest), manifest);
  assert.equal(manifestDigest(manifest), manifestDigest(structuredClone(manifest)));
  assert.deepEqual(validateAnnotation(annotation()), annotation());
  assert.deepEqual(parseKnowledgeCommand(`!knowledge profile ${authorId}`), {
    route: "profile",
    memberId: authorId,
  });
  assert.deepEqual(parseKnowledgeCommand(`!knowledge profile ${authorId} page 2`), {
    route: "profile",
    memberId: authorId,
    page: 2,
  });
  assert.deepEqual(parseKnowledgeCommand("!knowledge topic public-transit"), {
    route: "topic",
    topic: "public-transit",
  });
  assert.deepEqual(parseKnowledgeCommand("!knowledge topic public-transit page 3"), {
    route: "topic",
    topic: "public-transit",
    page: 3,
  });
  assert.deepEqual(validateKnowledgeViewQuery({ target: "profile", memberId: authorId }), {
    target: "profile",
    key: authorId,
  });
  assert.deepEqual(validateKnowledgeViewQuery({ target: "topic", topic: "public-transit" }), {
    target: "topic",
    key: "public-transit",
  });
  assert.deepEqual(
    validateKnowledgeViewQuery({ target: "history", memberId: authorId, topic: "public-transit" }),
    { target: "history", key: `${authorId}:public-transit` },
  );
  assert.deepEqual(parseKnowledgeCommand(`!knowledge history ${authorId} public-transit`), {
    route: "history",
    memberId: authorId,
    topic: "public-transit",
  });
  assert.deepEqual(parseKnowledgeCommand(`!knowledge history ${authorId} public-transit page 4`), {
    route: "history",
    memberId: authorId,
    topic: "public-transit",
    page: 4,
  });
  assert.deepEqual(
    parseKnowledgeCommand(
      `!knowledge correct https://discord.com/channels/${guildId}/${channelId}/${sourceId} clarify the scope`,
    ),
    { route: "correct", guildId, channelId, sourceId, note: "clarify the scope" },
  );
  assert.deepEqual(
    parseKnowledgeCommand(
      `!knowledge correct <https://discord.com/channels/${guildId}/${channelId}/${sourceId}> clarify the scope`,
    ),
    { route: "correct", guildId, channelId, sourceId, note: "clarify the scope" },
  );
  const sameGuildHistoricalCorrection = parseKnowledgeCommand(
    `!knowledge correct https://discord.com/channels/${guildId}/222222222222222223/${sourceId} clarify the scope`,
  );
  assert.equal(
    correctionRouteAllowed({ guildId, channelId }, sameGuildHistoricalCorrection),
    true,
    "a correction may cite active same-guild evidence outside the live reply channel",
  );
  assert.equal(
    correctionRouteAllowed(
      { guildId, channelId },
      { ...sameGuildHistoricalCorrection, guildId: "999999999999999999" },
    ),
    false,
  );
  assert.throws(() => validateArchiveManifest({ ...manifest, generation: 0 }));
  assert.throws(() => validateAnnotation({ ...annotation(), sourceIds: ["not-a-source"] }));
  assert.throws(() => parseKnowledgeCommand("!knowledge topic not a topic"));
  assert.throws(() => parseKnowledgeCommand(`!knowledge profile ${authorId} page 0`));
  assert.throws(() => parseKnowledgeCommand(`!knowledge profile ${authorId} page 10001`));
  assert.throws(() =>
    parseKnowledgeCommand(
      `!knowledge correct https://discord.com/channels/${guildId}/${channelId}/${sourceId}`,
    ),
  );
  assert.throws(() => validateKnowledgeViewQuery({ target: "topic", memberId: authorId }));
  let reads = 0;
  const retrieved = await retrieveCurrentKnowledgeView(
    {
      view: async () => {
        reads++;
        return reads === 1
          ? { entries: [{ sources: [{ sourceId }] }] }
          : { entries: [], incomplete: true };
      },
    },
    async (ids) => assert.deepEqual(ids, [sourceId]),
    async (ids) => {
      assert.deepEqual(ids, []);
      return [];
    },
    { target: "topic", topic: "public-transit" },
  );
  assert.deepEqual(retrieved, {
    target: "topic",
    key: "public-transit",
    document: { entries: [], incomplete: true },
    sources: [],
  });
  assert.equal(reads, 2, "source refresh must re-read the view before returning it");
  const projected = annotationsFromUnderstanding(
    [
      {
        key: "train-plan",
        kind: "plan",
        subjects: [authorId],
        topics: ["public-transit"],
        statement: "The speaker plans to take the train.",
        evidence: [{ messageId: sourceId, quote: "take the train" }],
      },
      {
        key: "mixed-history",
        kind: "statement",
        subjects: [authorId],
        topics: ["public-transit"],
        statement: "This crosses the selected episode.",
        evidence: [{ messageId: "555555555555555599", quote: "outside" }],
      },
    ],
    manifest.episodes[0],
  );
  assert.equal(projected.length, 1, "mixed-episode memory cannot become a review candidate");
  assert.deepEqual(projected[0].sourceIds, [sourceId]);
  assert.equal(projected[0].kind, "plan");
  assert.deepEqual(projected[0].sourceQuotes, [{ sourceId, quote: "take the train" }]);
  const multiQuote = annotationsFromUnderstanding(
    [
      {
        key: "qualified-train-preference",
        kind: "preference",
        subjects: [authorId],
        topics: ["public-transit"],
        statement: "The speaker prefers the train but would drive if service stops.",
        evidence: [
          { messageId: sourceId, quote: "I prefer the train." },
          { messageId: sourceId, quote: "I would drive if service stops." },
        ],
      },
    ],
    manifest.episodes[0],
  );
  assert.deepEqual(multiQuote[0].sourceIds, [sourceId]);
  assert.equal(multiQuote[0].kind, "preference");
  assert.deepEqual(multiQuote[0].sourceQuotes, [
    { sourceId, quote: "I prefer the train." },
    { sourceId, quote: "I would drive if service stops." },
  ]);
  const legacy = annotationsFromUnderstanding(
    [
      {
        key: "legacy-train-plan",
        kind: "statement",
        subjects: [authorId],
        statement: "The speaker plans to take the train.",
        evidence: [{ messageId: sourceId, quote: "take the train" }],
      },
    ],
    manifest.episodes[0],
  );
  assert.deepEqual(legacy[0].topics, [manifest.episodes[0].key]);
  assert.match(legacy[0].qualifications[0], /selected manifest episode key/);
  assert.doesNotMatch(legacy[0].qualifications[0], /founder-selected/);
  const topicLabels = annotationsFromUnderstanding(
    [
      {
        key: "uppercase-topic-label",
        kind: "statement",
        subjects: [authorId],
        topics: ["research", "AI"],
        statement: "The speaker mentioned AI research.",
        evidence: [{ messageId: sourceId, quote: "take the train" }],
      },
      {
        key: "unrepresentable-topic-label",
        kind: "statement",
        subjects: [authorId],
        topics: ["R&D"],
        statement: "The speaker mentioned a topic that is not a slug.",
        evidence: [{ messageId: sourceId, quote: "take the train" }],
      },
      {
        key: "colliding-topic-labels",
        kind: "statement",
        subjects: [authorId],
        topics: ["AI", "ai"],
        statement: "The speaker mentioned AI.",
        evidence: [{ messageId: sourceId, quote: "take the train" }],
      },
      {
        key: "free-form-topic-label",
        kind: "statement",
        subjects: [authorId],
        topics: ["Housing markets"],
        statement: "The speaker mentioned a free-form topic.",
        evidence: [{ messageId: sourceId, quote: "take the train" }],
      },
      {
        key: "empty-topic-labels",
        kind: "statement",
        subjects: [authorId],
        topics: [],
        statement: "The speaker mentioned a topic without labels.",
        evidence: [{ messageId: sourceId, quote: "take the train" }],
      },
    ],
    manifest.episodes[0],
  );
  assert.deepEqual(topicLabels[0].topics, ["research", "ai"]);
  assert.deepEqual(topicLabels[0].qualifications, []);
  assert.deepEqual(topicLabels[1].topics, [manifest.episodes[0].key]);
  assert.match(topicLabels[1].qualifications[0], /not lowercase slugs/);
  assert.match(topicLabels[1].qualifications[0], /selected manifest episode key/);
  assert.deepEqual(topicLabels[2].topics, ["ai"]);
  for (const fallback of topicLabels.slice(3)) {
    assert.deepEqual(fallback.topics, [manifest.episodes[0].key]);
    assert.match(fallback.qualifications[0], /selected manifest episode key/);
  }
  const previousManifestQualification =
    "Topic label is the founder-selected manifest episode key; inspect the cited sources.";
  const compact = renderKnowledgeView({
    target: "topic",
    key: "public-transit",
    entries: Array.from({ length: 5 }, (_, index) => ({
      interpretation: `Candidate ${index + 1}.`,
      kind: "plan",
      qualifications: [index === 0 ? previousManifestQualification : legacy[0].qualifications[0]],
      uncertainty: "unknown",
      competingWith: [],
      supersedes: null,
      episodeKey: "first-discussion",
      sources: [
        {
          sourceId,
          sourceRevision: 1,
          canonicalPermalink: `https://discord.com/channels/${guildId}/${channelId}/${sourceId}`,
        },
      ],
    })),
  });
  assert.equal(
    compact.split("Topic label: selected archive episode").length - 1,
    1,
    "current and legacy manifest-topic qualifications are shown once per compact view",
  );
  assert.match(compact, /uncertainty: unassessed/);
  assert.match(compact, /kind: plan/);
  assert.match(compact, /Topic label: selected archive episode/);
  assert.doesNotMatch(compact, /founder-selected/);
  assert.match(compact, /Page 1 of \d+ · (?:next:|end of current candidates)/);
});

test("current view withholds candidates whose sources appear only after refresh", async () => {
  for (const newSourceIsContext of [false, true]) {
    const original = { interpretation: "Original candidate", sources: [{ sourceId }] };
    const newcomer = newSourceIsContext
      ? {
          interpretation: "New context",
          sources: [{ sourceId }],
          contextSources: [{ sourceId: contextId }],
        }
      : { interpretation: "New candidate", sources: [{ sourceId: contextId }] };
    let reads = 0;
    const result = await retrieveCurrentKnowledgeView(
      { view: async () => ({ entries: ++reads === 1 ? [original] : [original, newcomer] }) },
      async (ids) => assert.deepEqual(ids, [sourceId]),
      async (ids) => ids.map((id) => ({ id })),
      { target: "topic", topic: "public-transit" },
    );
    assert.equal(reads, 2);
    assert.deepEqual(result.document.entries, [original]);
    assert.equal(result.document.incomplete, true);
    assert.equal(result.document.unavailableCandidateCount, 1);
    assert.deepEqual(result.sources, [{ id: sourceId }]);
  }
});

test("knowledge views label uncertainty without reversing its meaning in either layout", () => {
  for (const uncertainty of ["low", "medium", "high", "unknown"]) {
    for (const oversized of [false, true]) {
      const entry = {
        interpretation: "The speaker may prefer the train.",
        uncertainty,
        qualifications: oversized ? Array(8).fill("A qualification ".repeat(14)) : [],
        sources: [
          {
            sourceId,
            sourceRevision: 1,
            canonicalPermalink: `https://discord.com/channels/${guildId}/${channelId}/${sourceId}`,
          },
        ],
      };
      const document = { target: "topic", key: "public-transit", entries: [entry] };
      const pages = [renderKnowledgeView(document)];
      while (pages.at(-1).includes(" · next: `")) {
        const command = /next: `(.*)`/.exec(pages.at(-1))[1];
        pages.push(renderKnowledgeView(document, { page: parseKnowledgeCommand(command).page }));
        assert.ok(pages.length <= 10);
      }
      const output = pages.join("\n");
      const expected = uncertainty === "unknown" ? "unassessed" : uncertainty;
      assert.match(output, new RegExp(`uncertainty: ${expected}`));
      assert.doesNotMatch(output, /confidence:/);
      if (oversized) assert.match(output, /Candidate 1 — uncertainty:/);
      else assert.doesNotMatch(output, /Candidate 1 — uncertainty:/);
      assert.ok(pages.every((page) => page.length <= 1800));
    }
  }
});

test("knowledge views paginate every cited candidate in stable order with complete evidence", () => {
  const candidates = Array.from({ length: 11 }, (_, index) => {
    const sourceA = String(700000000000000000n + BigInt(index * 2 + 1));
    const sourceB = String(700000000000000000n + BigInt(index * 2 + 2));
    const urlA = `https://discord.com/channels/${guildId}/${channelId}/${sourceA}`;
    const urlB = `https://discord.com/channels/${guildId}/${channelId}/${sourceB}`;
    return {
      interpretation: `Candidate ${String(index + 1).padStart(2, "0")}: ${"a supported interpretation ".repeat(4)}${index + 1}.`,
      kind: "preference",
      qualifications: [`Qualification ${index + 1}: only in the stated context.`],
      uncertainty: "low",
      competingWith: [],
      supersedes: null,
      episodeKey: "first-discussion",
      sources: [
        { sourceId: sourceA, sourceRevision: 2, canonicalPermalink: urlA },
        { sourceId: sourceB, sourceRevision: 1, canonicalPermalink: urlB },
      ],
      claims: [
        {
          id: `claim-${index + 1}`,
          text: `Claim ${index + 1}`,
          subjectIds: [authorId],
          anchors: [
            {
              sourceId: sourceA,
              quote: "supported",
              relation: "supports",
              attributedTo: authorId,
            },
          ],
        },
      ],
    };
  });
  const sourceIds = candidates.flatMap((candidate) =>
    candidate.sources.map((source) => source.sourceId),
  );
  assert.equal(
    new Set(sourceIds).size,
    sourceIds.length,
    "each fixture source has a distinct snowflake",
  );
  const document = { target: "topic", key: "public-transit", entries: candidates };
  const first = renderKnowledgeView(document);
  const repeated = renderKnowledgeView(document);
  assert.equal(first, repeated, "page boundaries and ordering are deterministic");

  const pages = [first];
  while (pages.at(-1).includes(" · next: `")) {
    const command = /next: `(.*)`/.exec(pages.at(-1))?.[1];
    assert.ok(command, "next-page command is present");
    const parsed = parseKnowledgeCommand(command);
    assert.equal(parsed.route, "topic");
    pages.push(renderKnowledgeView(document, { page: parsed.page }));
    assert.ok(pages.length <= candidates.length, "pagination must make progress");
  }

  assert.ok(pages.length > 1, "the fixture exceeds one message without truncating entries");
  assert.ok(pages.every((page) => page.length <= 1800));
  const joined = pages.join("\n");
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    assert.equal(joined.split(candidate.interpretation).length - 1, 1);
    assert.equal(joined.split(candidate.qualifications[0]).length - 1, 1);
    assert.ok(joined.includes(candidate.sources[0].canonicalPermalink));
    assert.ok(joined.includes(candidate.sources[1].canonicalPermalink));
    assert.equal(joined.split(`claim-${index + 1}[`).length - 1, 1);
  }
  const order = candidates.map((candidate) => joined.indexOf(candidate.interpretation));
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
  );
  assert.match(pages.at(-1), /end of current candidates/);
  assert.match(renderKnowledgeView(document, { page: pages.length + 1 }), /no longer available/);
});

test("one oversized cited candidate continues structurally without splitting citations or parent boundaries", () => {
  const sourceIds = Array.from({ length: 6 }, (_, index) =>
    String(720000000000000000n + BigInt(index)),
  );
  const parentIds = Array.from({ length: 5 }, (_, index) =>
    String(720000000000000010n + BigInt(index)),
  );
  const interpretation = `Opening position. ${"A carefully attributed supporting clause remains attached to the same candidate. ".repeat(8)}Closing qualification.`;
  assert.ok(interpretation.length <= 800, "fixture stays within the annotation field limit");
  const qualifications = [
    "Keep the dated position distinct from a current endorsement.",
    "The unselected reply parent remains outside the reviewed evidence.",
    "A later qualification does not erase the earlier view.",
    "No claim here is treated as independently verified fact.",
  ];
  const candidate = {
    interpretation,
    kind: "statement",
    qualifications,
    uncertainty: "unknown",
    competingWith: [],
    supersedes: null,
    episodeKey: "identity-rules",
    sources: sourceIds.map((id) => ({
      sourceId: id,
      sourceRevision: 1,
      canonicalPermalink: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
    })),
    contextSources: [],
    replyBoundaries: parentIds.map((id) => ({
      parentSourceId: id,
      status: "outside-selected-slice",
      canonicalPermalink: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
    })),
    claims: [
      {
        id: "identity-claim",
        text: "The attributed position depends on its dated discussion context.",
        subjectIds: [authorId],
        anchors: [
          {
            sourceId: sourceIds[0],
            quote: "dated discussion context",
            relation: "supports",
            attributedTo: authorId,
          },
          {
            sourceId: sourceIds[5],
            quote: "later qualification",
            relation: "qualifies",
            attributedTo: authorId,
          },
        ],
      },
    ],
  };
  const document = { target: "topic", key: "identity-rules", entries: [candidate] };
  const first = renderKnowledgeView(document);
  const pages = [first];
  while (pages.at(-1).includes(" · next: `")) {
    const command = /next: `(.*)`/.exec(pages.at(-1))?.[1];
    assert.ok(command);
    pages.push(renderKnowledgeView(document, { page: parseKnowledgeCommand(command).page }));
    assert.ok(pages.length <= 20, "each continuation page must make progress");
  }
  assert.equal(first, renderKnowledgeView(document), "continuation boundaries are deterministic");
  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.length <= 1800));
  const rendered = pages.join("\n");
  const interpretationLines = rendered
    .split("\n")
    .filter((line) => /Candidate 1(?: \(continued\))? — interpretation: /.test(line))
    .map((line) => line.replace(/^.*?— interpretation: /, ""));
  assert.equal(interpretationLines.join(" "), interpretation.replace(/\s+/g, " "));
  for (const qualification of qualifications) assert.ok(rendered.includes(qualification));
  assert.match(rendered, /claim identity-claim/);
  assert.match(rendered, /supports by 333333333333333333/);
  assert.match(rendered, /qualifies by 333333333333333333/);
  for (const id of sourceIds) {
    const link = `https://discord.com/channels/${guildId}/${channelId}/${id}`;
    assert.ok(rendered.includes(`[${id} r1](${link})`));
  }
  for (const id of parentIds) {
    const link = `https://discord.com/channels/${guildId}/${channelId}/${id}`;
    assert.equal(rendered.split(`[${id}](${link})`).length - 1, 1);
  }
});

test("maximum-length history commands keep continuation pages within the message limit", () => {
  const memberId = "11111111111111111111";
  const topic = "t".repeat(64);
  const entries = Array.from({ length: 48 }, (_, index) => {
    const id = String(710000000000000000n + BigInt(index));
    return {
      interpretation: `Candidate ${index + 1}: ${"supported detail ".repeat(20)}`,
      qualifications: ["This applies only to the described context."],
      uncertainty: "low",
      competingWith: [],
      sources: [
        {
          sourceId: id,
          sourceRevision: 1,
          canonicalPermalink: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
        },
      ],
    };
  });
  const document = { target: "history", key: `${memberId}:${topic}`, entries };
  const page = renderKnowledgeView(document, { page: 10 });
  assert.ok(page.length <= 1800, `page has ${page.length} characters`);
  assert.match(
    page,
    /Page 10 of \d+ · next: `!knowledge history 11111111111111111111 t{64} page 11`/,
  );
  assert.deepEqual(parseKnowledgeCommand(/next: `(.*)`/.exec(page)?.[1]), {
    route: "history",
    memberId,
    topic,
    page: 11,
  });
});

test("current-source filtering withholds stale candidates before pagination", async () => {
  const availableId = "700000000000000901";
  const deletedId = "700000000000000902";
  const candidate = (interpretation, id) => ({
    interpretation,
    kind: "statement",
    qualifications: ["Only this narrow observation."],
    uncertainty: "low",
    competingWith: [],
    supersedes: null,
    sources: [
      {
        sourceId: id,
        sourceRevision: 1,
        canonicalPermalink: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
      },
    ],
  });
  const raw = {
    target: "profile",
    key: authorId,
    entries: [
      candidate("Still current candidate.", availableId),
      candidate("Deleted candidate.", deletedId),
    ],
  };
  let reads = 0;
  const result = await retrieveCurrentKnowledgeView(
    { view: async () => (reads++ === 0 ? structuredClone(raw) : structuredClone(raw)) },
    async (ids) => assert.deepEqual(ids, [availableId, deletedId]),
    async (ids) => {
      assert.deepEqual(ids, [availableId, deletedId]);
      return [{ id: availableId }];
    },
    { target: "profile", memberId: authorId },
  );
  assert.equal(result.document.incomplete, true);
  assert.equal(result.document.unavailableCandidateCount, 1);
  const output = renderKnowledgeView(result.document);
  assert.match(output, /Still current candidate/);
  assert.doesNotMatch(output, /Deleted candidate|700000000000000902/);
  assert.match(
    output,
    /1 candidate was withheld because current source evidence is unavailable or incomplete/,
  );
});

test(
  "PostgreSQL knowledge jobs survive replacement, reject stale source work, and block delayed exports",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () => {
    const { default: pg } = await import("pg");
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const admin = new pg.Client(credentials);
    await admin.connect();
    const database = "mudfut_knowledge_" + randomUUID().replaceAll("-", "");
    let db;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      db = new pg.Client({ ...credentials, database });
      await db.connect();
      let knowledge = await communityKnowledge(db);
      await knowledge.installManifest(manifest);
      await knowledge.registerSource(source(sourceId, "I will take the train for this trip."));
      await knowledge.registerSource(source(contextId, "Parking is a mess around the station."));

      const staleWork = await knowledge.prepareAnnotation({
        manifestId: manifest.id,
        episodeKey: "first-discussion",
        candidate: annotation(),
      });
      await knowledge.registerSource(
        source(sourceId, "I will take the train for this trip, unless the weather turns."),
      );
      assert.deepEqual(await knowledge.commitAnnotation(staleWork), {
        disposition: "stale-source",
      });
      assert.equal(
        (await db.query("SELECT count(*)::int AS count FROM pilot_knowledge_annotations")).rows[0]
          .count,
        0,
      );
      assert.equal(
        (await db.query("SELECT status FROM pilot_knowledge_jobs WHERE id=$1", [staleWork.id]))
          .rows[0].status,
        "stale",
      );

      // Reopening the client models a worker restart: durable manifest/source state,
      // not process memory, decides whether the next candidate may commit.
      await db.end();
      db = new pg.Client({ ...credentials, database });
      await db.connect();
      knowledge = await communityKnowledge(db);
      const currentWork = await knowledge.prepareAnnotation({
        manifestId: manifest.id,
        episodeKey: "first-discussion",
        candidate: annotation({
          interpretation:
            "The speaker prefers the train for this trip while leaving weather as a qualification.",
          qualifications: ["Weather may change the plan."],
        }),
      });
      assert.equal((await knowledge.commitAnnotation(currentWork)).disposition, "applied");
      const replayWork = await knowledge.prepareAnnotation({
        manifestId: manifest.id,
        episodeKey: "first-discussion",
        candidate: annotation({
          interpretation:
            "The speaker prefers the train for this trip while leaving weather as a qualification.",
          qualifications: ["Weather may change the plan."],
        }),
      });
      assert.equal(
        (await knowledge.commitAnnotation(replayWork)).disposition,
        "already-applied",
        "restart replay must not create a duplicate current interpretation",
      );
      assert.equal(
        (await db.query("SELECT count(*)::int AS count FROM pilot_knowledge_annotations")).rows[0]
          .count,
        1,
      );
      const profile = await knowledge.prepareExport({ target: "profile", key: authorId });
      assert.match(renderKnowledgeView(profile.document), /candidate interpretations/);
      assert.match(renderKnowledgeView(profile.document), /discord\.com\/channels/);

      const correction = await knowledge.correct({
        route: "correct",
        guildId,
        channelId,
        sourceId,
        note: "The interpretation needs a correction.",
      });
      assert.equal(correction.disposition, "correction-opened");
      assert.match(correction.correctionId, /^[0-9a-f-]{36}$/);
      assert.match(
        renderKnowledgeView(await knowledge.view("profile", authorId)),
        /no current cited/,
        "a correction must immediately withdraw dependent candidate views",
      );
      assert.equal(
        (await db.query("SELECT count(*)::int AS count FROM pilot_knowledge_corrections")).rows[0]
          .count,
        1,
      );
      const retry = await knowledge.correct({
        route: "correct",
        guildId,
        channelId,
        sourceId,
        note: "The interpretation needs a correction.",
      });
      assert.deepEqual(retry, {
        disposition: "already-open",
        correctionId: correction.correctionId,
        sourceId,
      });
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM pilot_knowledge_receipts WHERE kind='correction-opened'",
          )
        ).rows[0].count,
        1,
        "retrying a correction cannot create duplicate audit receipts",
      );
      const report = await communityKnowledgeStatus(db);
      assert.equal(report.status, "ready");
      assert.ok(report.observedSources.current >= 1);
      assert.equal(report.manifestSources.current, 2);
      assert.ok(report.jobs["requeued:effective"] >= 1);
      assert.equal(report.annotations.invalidated, 1);
      assert.deepEqual(report.annotationQuoteCoverage, { candidate: 0, quoted: 0 });
      assert.equal(report.corrections.open, 1);
      assert.equal(report.receipts["correction-opened"], 1);

      await knowledge.removeSource(sourceId);
      assert.deepEqual(await knowledge.commitExport(profile), { disposition: "stale-view" });
      assert.match(
        renderKnowledgeView(await knowledge.view("profile", authorId)),
        /no current cited/,
      );
      assert.deepEqual(
        (await knowledge.requeuedJobs()).map((job) => job.id),
        [currentWork.id],
        "only source-dependent completed work is queued for the refreshed historical episode",
      );
      const receipts = await knowledge.receipts();
      assert.ok(receipts.some((receipt) => receipt.kind === "stale-worker-result"));
      assert.ok(receipts.some((receipt) => receipt.kind === "stale-export"));
      assert.ok(receipts.some((receipt) => receipt.kind === "correction-opened"));
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
  },
);

test(
  "PostgreSQL views retain every quote span while using one source identity",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () => {
    const { default: pg } = await import("pg");
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const admin = new pg.Client(credentials);
    await admin.connect();
    const database = "mudfut_knowledge_quotes_" + randomUUID().replaceAll("-", "");
    let db;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      db = new pg.Client({ ...credentials, database });
      await db.connect();
      const knowledge = await communityKnowledge(db);
      await knowledge.installManifest(manifest);
      await knowledge.registerSource(
        source(sourceId, "I prefer the train. I would drive if service stops."),
      );
      await knowledge.registerSource(source(contextId, "The trip is about the rail strike."));
      const work = await knowledge.prepareAnnotation({
        manifestId: manifest.id,
        episodeKey: "first-discussion",
        candidate: annotation({
          id: "qualified-preference",
          kind: "preference",
          contextSourceIds: [contextId],
          sourceQuotes: [
            { sourceId, quote: "I prefer the train." },
            { sourceId, quote: "I would drive if service stops." },
          ],
        }),
      });
      assert.equal((await knowledge.commitAnnotation(work)).disposition, "applied");
      const profile = await knowledge.view("profile", authorId);
      assert.equal(profile.entries[0].kind, "preference");
      assert.deepEqual(profile.entries[0].sources, [
        {
          sourceId,
          sourceRevision: 1,
          authorId,
          exactQuote: "I prefer the train. I would drive if service stops.",
          quoteSpans: ["I prefer the train.", "I would drive if service stops."],
          canonicalPermalink: `https://discord.com/channels/${guildId}/${channelId}/${sourceId}`,
          createdAt: "2026-10-16T12:00:00.000Z",
        },
      ]);
      assert.deepEqual(profile.entries[0].contextSources, [
        {
          sourceId: contextId,
          sourceRevision: 1,
          authorId,
          exactQuote: "The trip is about the rail strike.",
          quoteSpans: [],
          canonicalPermalink: `https://discord.com/channels/${guildId}/${channelId}/${contextId}`,
          createdAt: "2026-10-16T12:00:00.000Z",
        },
      ]);
      assert.deepEqual((await communityKnowledgeStatus(db)).annotationQuoteCoverage, {
        candidate: 1,
        quoted: 1,
      });
      await knowledge.removeSource(contextId);
      assert.equal(
        (await knowledge.view("profile", authorId)).entries.length,
        0,
        "a missing context dependency cannot leave an otherwise plausible reading current",
      );
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
  },
);

test(
  "history views order claims by cited source time instead of annotation creation time",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () => {
    const { default: pg } = await import("pg");
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const admin = new pg.Client(credentials);
    await admin.connect();
    const database = "mudfut_knowledge_chronology_" + randomUUID().replaceAll("-", "");
    let db;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      db = new pg.Client({ ...credentials, database });
      await db.connect();
      const knowledge = await communityKnowledge(db);
      const laterSourceId = "555555555555555503";
      const chronologyManifest = structuredClone(manifest);
      chronologyManifest.episodes[0].sourceIds.push(laterSourceId);
      await knowledge.installManifest(chronologyManifest);
      await knowledge.registerSource(source(sourceId, "This happened first."));
      await knowledge.registerSource({
        ...source(laterSourceId, "This happened later."),
        createdAt: "2026-10-18T12:00:00.000Z",
      });
      const later = annotation({
        id: "later-event",
        sourceIds: [laterSourceId],
        sourceQuotes: [{ sourceId: laterSourceId, quote: "This happened later." }],
        interpretation: "The later event.",
      });
      const earlier = annotation({
        id: "earlier-event",
        interpretation: "The earlier event.",
      });
      await knowledge.commitAnnotation(
        await knowledge.prepareAnnotation({
          manifestId: chronologyManifest.id,
          episodeKey: "first-discussion",
          candidate: later,
        }),
      );
      await knowledge.commitAnnotation(
        await knowledge.prepareAnnotation({
          manifestId: chronologyManifest.id,
          episodeKey: "first-discussion",
          candidate: earlier,
        }),
      );
      const history = await knowledge.view("history", `${authorId}:public-transit`);
      assert.deepEqual(
        history.entries.map((entry) => entry.annotationId),
        ["earlier-event", "later-event"],
      );
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
  },
);
