import assert from "node:assert/strict";
import { test } from "node:test";
import { historyArchive, historyMessage } from "./pilot-baseline-history.mjs";

test("historical rows become source-record-compatible messages", () => {
  assert.deepEqual(
    historyMessage({
      id: "555555555555555555",
      guildId: "111111111111111111",
      channelId: "222222222222222222",
      authorId: "333333333333333333",
      authorName: "Member",
      content: "A stored source",
      createdAt: "2026-10-18T00:00:00.000Z",
      editedAt: null,
      replyTo: "444444444444444444",
    }),
    {
      id: "555555555555555555",
      type: 19,
      channel_id: "222222222222222222",
      author: { id: "333333333333333333", username: "Member" },
      content: "A stored source",
      timestamp: "2026-10-18T00:00:00.000Z",
      edited_timestamp: null,
      message_reference: { message_id: "444444444444444444" },
    },
  );
  assert.throws(() => historyMessage({ id: "missing fields" }));
});

test("historical source lookup preserves requested order and rejects unavailable sources", async () => {
  const rows = new Map(
    [
      [
        "555555555555555555",
        {
          id: "555555555555555555",
          guildId: "111111111111111111",
          channelId: "222222222222222222",
          authorId: "333333333333333333",
          authorName: "Member",
          content: "First source",
          createdAt: "2026-10-18T00:00:00.000Z",
          editedAt: null,
          replyTo: null,
        },
      ],
      [
        "666666666666666666",
        {
          id: "666666666666666666",
          guildId: "111111111111111111",
          channelId: "222222222222222222",
          authorId: "333333333333333333",
          authorName: "Member",
          content: "Second source",
          createdAt: "2026-10-18T00:01:00.000Z",
          editedAt: null,
          replyTo: null,
        },
      ],
    ].map(([id, row]) => [id, row]),
  );
  const history = {
    async query(sql, values) {
      if (sql.includes("SELECT m.message_id AS id"))
        return { rows: values[0].map((id) => rows.get(id)).filter(Boolean) };
      throw new Error(`Unexpected test query: ${sql}`);
    },
  };
  const archive = historyArchive(history);
  const sources = await archive.sourceLookup(["666666666666666666", "555555555555555555"]);
  assert.deepEqual(
    sources.map(({ id }) => id),
    ["666666666666666666", "555555555555555555"],
  );
  await assert.rejects(archive.sourceLookup(["777777777777777777"]), /lacks source/);
});
