import assert from "node:assert/strict";
import test from "node:test";

import { memberPositions } from "./pilot-profile.mjs";

function history(script) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: script(sql, params) };
    },
  };
}

test("a name resolves to one member and returns clipped statements", async () => {
  const db = history((sql) => {
    if (sql.includes("lower(author_display_name)"))
      return [{ id: "123456789012345678", name: "Ada" }];
    return [
      {
        memberId: "123456789012345678",
        topic: "housing",
        proposition: "Build more of it",
        quote: "x".repeat(300),
        kind: "exact_quote",
        messageId: "223456789012345678",
        at: "2026-11-01T00:00:00.000000Z",
      },
    ];
  });
  const result = await memberPositions(db, {
    guildId: "guild",
    botId: "bot",
    member: "Ada",
  });
  assert.equal(result.scope, "member");
  assert.equal(result.member.name, "Ada");
  assert.equal(result.statements[0].quote.length, 280);
  assert.equal(result.statements[0].messageId, "223456789012345678");
  assert.doesNotMatch(db.calls.at(-1).sql, /opted_out|v2_member_eligibility/);
});

test("several names stay unresolved and a topic search does not pick a member", async () => {
  const ambiguous = await memberPositions(
    history(() => [
      { id: "123456789012345678", name: "Ada" },
      { id: "123456789012345679", name: "Adan" },
    ]),
    { guildId: "guild", member: "Ada" },
  );
  assert.equal(ambiguous.scope, "ambiguous");
  assert.equal(ambiguous.members.length, 2);

  const topic = await memberPositions(
    history(() => [
      {
        memberId: "123456789012345678",
        name: "Ada",
        topic: "housing",
        proposition: "Build",
        quote: "Build",
        kind: "direct_statement",
        messageId: "223456789012345678",
        at: "2026-11-01T00:00:00.000000Z",
      },
    ]),
    { guildId: "guild", topic: "housing" },
  );
  assert.equal(topic.scope, "topic");
  assert.equal(topic.statements[0].name, "Ada");
});

test("no member returns the roster", async () => {
  const result = await memberPositions(
    history(() => [{ id: "123456789012345678", name: "Ada", statements: 4 }]),
    { guildId: "guild", botId: "bot" },
  );
  assert.equal(result.scope, "roster");
  assert.equal(result.members[0].statements, 4);
});
