import assert from "node:assert/strict";
import test from "node:test";
import {
  profileSources,
  validateProfileArtifacts,
  validateProfileOriginals,
} from "./pilot-profile.mjs";
import { statementDigest } from "./member-profile.mjs";
import { replyEvidence } from "./pilot-reply.mjs";

const guild = "100000000000000001";
const channel = "300000000000000001";
const member = "200000000000000001";
const message = "500000000000000001";
const original = {
  id: message,
  channel_id: channel,
  guild_id: guild,
  author: { id: member, username: "Ada" },
  content: "I support a levy only if the accounts are public.",
  timestamp: "2026-01-01T00:00:00.000Z",
  edited_timestamp: null,
};
const row = {
  memberId: member,
  statementId: "statement-one",
  revisionId: "revision-one",
  messageId: message,
  channelId: channel,
  freshness: "current",
  quote: "I support a levy",
  proposition: "Unsupported normalized paraphrase",
  sourceContent: original.content,
  occurredAt: original.timestamp,
  sourceCreatedAt: original.timestamp,
  authorName: "Ada",
};

test("profile provenance registers original bytes, not an extracted paraphrase", async () => {
  const sources = profileSources({ evidence: [{ statementId: row.statementId }] }, [row], guild);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].content, original.content);
  assert.notEqual(sources[0].content, row.proposition);
  assert.equal(
    profileSources(
      { evidence: [{ statementId: row.statementId }] },
      [{ ...row, freshness: "invalidated" }],
      guild,
    ).length,
    0,
  );
  await validateProfileOriginals({ get: async () => structuredClone(original) }, sources);
});

test("source edits, deletion, revision timestamp changes, and identity mismatch block a profile reply", async () => {
  const sources = profileSources({ messageId: message }, [row], guild);
  for (const changed of [
    null,
    { ...original, content: "I oppose the levy." },
    { ...original, edited_timestamp: "2026-02-01T00:00:00.000Z" },
    { ...original, author: { ...original.author, id: "200000000000000002" } },
    { ...original, channel_id: "300000000000000002" },
  ])
    await assert.rejects(
      () => validateProfileOriginals({ get: async () => changed }, sources),
      /Profile source|Invalid Discord source/,
    );
});

test("member profile reads enter the same reply-evidence trace as archive reads", () => {
  const trace = replyEvidence({ content: "", revision: "none" }, { rows: [], context: {} });
  const sources = profileSources({ messageId: message }, [row], guild);
  trace.observe(
    "member_positions",
    { member, view: "topic", topic: "levy" },
    { sources, coverage: { pending: true } },
  );
  const saved = trace.snapshot();
  assert.equal(saved.archiveReads.length, 1);
  assert.equal(saved.archiveReads[0].tool, "member_positions");
  assert.equal(saved.archiveReads[0].sources[0].id, message);
  assert.equal(saved.archiveReads[0].sources[0].content, original.content);
});

test("artifact invalidation blocks an answer even if the original message bytes did not change", async () => {
  const current = {
    ...row,
    guildId: guild,
    kind: "exact_quote",
    messageFound: true,
    revisionFound: true,
    isCurrent: true,
    messageHash: "same",
    revisionHash: "same",
    invalidated: false,
    sourceContext: [],
  };
  const references = [
    {
      guildId: guild,
      memberId: member,
      statementId: row.statementId,
      channelId: channel,
      inputDigest: statementDigest(current),
    },
  ];
  let result = current;
  const history = { query: async () => ({ rows: [result] }) };
  await validateProfileArtifacts(history, references, { visibleChannelIds: [channel] });
  result = { ...current, invalidated: true };
  await assert.rejects(
    () => validateProfileArtifacts(history, references, { visibleChannelIds: [channel] }),
    /revised or invalidated/,
  );
  await assert.rejects(
    () => validateProfileArtifacts(history, references, { visibleChannelIds: [] }),
    /no longer visible/,
  );
});
