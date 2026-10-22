import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertResearchArchiveAuthority,
  exportResearchEpisode,
  researchEpisodeQuery,
  validateResearchManifest,
} from "./pilot-research-export.mjs";

const manifest = {
  id: "finance-insurance-2026-07-17",
  guildId: "111111111111111111",
  channelId: "222222222222222222",
  start: "2026-07-17T13:56:00.000Z",
  end: "2026-07-17T14:20:00.000Z",
  sourceIds: ["555555555555555501", "555555555555555502"],
};
const rows = [
  {
    message_id: manifest.sourceIds[0],
    author_id: "333333333333333333",
    author_display_name: "Maxitaur",
    content: "Rare private disability insurance.",
    created_at: new Date("2026-07-17T13:56:00.321Z"),
    reply_to_message_id: null,
  },
  {
    message_id: manifest.sourceIds[1],
    author_id: "444444444444444444",
    author_display_name: "Example member",
    content: "It can be an insurance add-on.",
    created_at: "2026-07-17T14:00:00.000Z",
    reply_to_message_id: manifest.sourceIds[0],
  },
];

test("research export uses only the manifest IDs in a repeatable read-only transaction", async () => {
  const queries = [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      return text.startsWith("SELECT") ? { rows } : { rows: [] };
    },
  };
  const receipt = await exportResearchEpisode(client, manifest);
  assert.deepEqual(
    queries.map((query) => (query.text.startsWith("SELECT") ? "SELECT" : query.text)),
    ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "SELECT", "ROLLBACK"],
  );
  assert.deepEqual(queries[1].values, [
    manifest.guildId,
    manifest.channelId,
    manifest.sourceIds,
    manifest.start,
    manifest.end,
  ]);
  assert.equal(receipt.sources[1].replyToMessageId, manifest.sourceIds[0]);
  assert.equal(receipt.sources[0].createdAt, "2026-07-17T13:56:00.321Z");
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
});

test("research export rejects unbounded manifests and incomplete archive results", async () => {
  assert.throws(() =>
    validateResearchManifest({
      ...manifest,
      sourceIds: [...manifest.sourceIds, manifest.sourceIds[0]],
    }),
  );
  assert.throws(() => validateResearchManifest({ ...manifest, end: "2026-07-17T15:00:01.000Z" }));
  assert.throws(() =>
    assertResearchArchiveAuthority({ host: "db.example", user: "mudfut_history_reader" }),
  );
  assert.match(researchEpisodeQuery(manifest).text, /message_id=ANY\(\$3::text\[\]\)/);
  const calls = [];
  await assert.rejects(
    exportResearchEpisode(
      {
        query: async (text) => (
          calls.push(text),
          text.startsWith("SELECT") ? { rows: rows.slice(0, 1) } : { rows: [] }
        ),
      },
      manifest,
    ),
    /exactly the manifest source IDs/,
  );
  assert.equal(calls.at(-1), "ROLLBACK", "failed exports still close their read-only transaction");
});
