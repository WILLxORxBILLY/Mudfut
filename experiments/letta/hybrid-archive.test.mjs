import assert from "node:assert/strict";
import test from "node:test";

import {
  embedArchiveQuery,
  semanticArchiveMessages,
  semanticArchiveSql,
  vectorLiteral,
} from "./pilot-hybrid.mjs";

test("vector literal accepts only a finite 1536-dimensional embedding", () => {
  assert.equal(vectorLiteral([1, Number.NaN]), null);
  assert.equal(vectorLiteral(Array(1536).fill(0.25)), `[${Array(1536).fill(0.25).join(",")}]`);
});

test("query embedding uses the stored chunk model and fails closed", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    let seen;
    const vector = await embedArchiveQuery("housing", async (_url, init) => {
      seen = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: Array(1536).fill(0.5) }] }),
      };
    });
    assert.equal(seen.model, "text-embedding-3-small");
    assert.equal(seen.dimensions, 1536);
    assert.ok(vector.startsWith("[0.5,"));
    assert.equal(
      await embedArchiveQuery("housing", async () => {
        throw new Error("offline");
      }),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("semantic search reads chunks only and keeps a lexical path without an embedding", async () => {
  assert.match(semanticArchiveSql(true), /embedding <=> \$1::vector/);
  assert.doesNotMatch(semanticArchiveSql(false), /embedding <=>/);
  assert.match(semanticArchiveSql(false), /chunks/);
  assert.doesNotMatch(semanticArchiveSql(false), /v2_/);
  const calls = [];
  const history = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: "123", guildId: "g", channelId: "c" }, { id: "" }] };
    },
  };
  const rows = await semanticArchiveMessages(
    history,
    { guildId: "g", query: "rent", channelIds: ["c"] },
    async () => ({ ok: false }),
  );
  assert.deepEqual(rows, [{ id: "123", guildId: "g", channelId: "c" }]);
  assert.equal(calls[0].params[0], null);
  assert.equal(calls[0].params[1], "g");
  assert.deepEqual(calls[0].params[2], ["c"]);
  assert.equal(calls[0].params[8], false);
  assert.match(calls[0].sql, /msg.author_id = ANY/);
  assert.doesNotMatch(calls[0].sql, /v2_/);
});
