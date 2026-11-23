import assert from "node:assert/strict";
import test from "node:test";
import { recallSources } from "./pilot-discord.mjs";
import { sourceRecord } from "./pilot-store.mjs";
import { encodeUnderstanding, readUnderstanding } from "./pilot-memory.mjs";

const guildId = "111111111111111111";
const channelId = "222222222222222222";
const oldId = "555555555555555501";
const liveId = "555555555555555551";
const message = (id, content = "Fictional shared conceptual framework") => ({
  id,
  channel_id: channelId,
  author: { id: "333333333333333333", username: "Fixture" },
  content,
  timestamp: "2026-01-01T00:00:00Z",
});
const original = sourceRecord(message(oldId), guildId, channelId);
const live = sourceRecord(message(liveId), guildId, channelId);
const policy = {
  phase: "live-only",
  frontiers: { [channelId]: "555555555555555550" },
  protectedSourceIds: [],
};
function fixture({ response = message(oldId), p = policy, rows = [{ source: original }] } = {}) {
  const calls = [];
  const store = {
    recovery: async () => p,
    findSources: async (ids) => (ids.includes(liveId) ? [live] : []),
    db: {
      query: async (sql, values) => {
        calls.push({ sql, values });
        assert.match(sql, /^SELECT /);
        assert.match(sql, /NOT s.deleted/);
        assert.match(sql, /NOT EXISTS\(SELECT 1 FROM pilot_source_holds/);
        return { rows };
      },
    },
  };
  const discord = {
    get: async (channel, id) => {
      calls.push({ channel, id });
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { store, discord, calls };
}

test("retained pre-frontier understanding resolves through fresh read-only originals", async () => {
  const { store, discord, calls } = fixture();
  const sources = new Map();
  const entry = {
    key: "fictional-framework",
    kind: "fact",
    subjects: [original.authorId],
    statement: "The fictional members developed a shared conceptual framework.",
    evidence: [{ messageId: oldId, quote: "shared conceptual framework" }],
    sourceIds: [oldId],
  };
  const draft = { content: encodeUnderstanding([entry]), revision: "fixture" };
  const result = await readUnderstanding(draft, { keys: [entry.key] }, sources, async (ids) => {
    for (const source of await recallSources(store, discord, ids)) sources.set(source.id, source);
  });
  assert.equal(result.entries[0].key, entry.key);
  assert.equal(result.sources[0].messageId, oldId);
  assert.equal(calls.filter((call) => call.id === oldId).length, 1);
  assert.equal(calls.filter((call) => call.sql).length, 1);
});

test("live evidence keeps its existing validated path, without historical reads", async () => {
  const { store, discord, calls } = fixture();
  assert.deepEqual(await recallSources(store, discord, [liveId]), [live]);
  assert.equal(calls.length, 0);
});

test("protected and unreleased historical originals remain withheld without transport", async () => {
  for (const p of [
    { ...policy, protectedSourceIds: [oldId] },
    { ...policy, frontiers: {} },
  ]) {
    const { store, discord, calls } = fixture({ p });
    assert.deepEqual(await recallSources(store, discord, [oldId]), []);
    assert.equal(calls.filter((call) => call.id).length, 0);
  }
});

test("missing, held or tombstoned sources never fall back to stale cached text", async () => {
  for (const options of [{ response: null }, { rows: [] }]) {
    const { store, discord } = fixture(options);
    assert.deepEqual(await recallSources(store, discord, [oldId]), []);
  }
  const { store, discord } = fixture({ response: message(oldId, "Changed original") });
  assert.deepEqual(await recallSources(store, discord, [oldId]), []);
});

test("historical source transport failures propagate instead of becoming deletion", async () => {
  const error = Object.assign(new Error("Temporary read failure"), { status: 503 });
  const { store, discord } = fixture({ response: error });
  await assert.rejects(recallSources(store, discord, [oldId]), (actual) => actual === error);
});

test("turn cancellation stops further historical reads before another request", async () => {
  const secondOld = { ...original, id: "555555555555555502" };
  const { store, calls } = fixture({ rows: [{ source: original }, { source: secondOld }] });
  const error = Object.assign(new Error("Model turn deadline exceeded"), {
    code: "MODEL_TURN_DEADLINE",
  });
  let cancelled = false;
  const discord = {
    get: async (_channel, id) => {
      calls.push({ id });
      cancelled = true;
      return message(id);
    },
  };
  await assert.rejects(
    recallSources(store, discord, [oldId, secondOld.id], async () => {
      if (cancelled) throw error;
    }),
    (actual) => actual === error,
  );
  assert.deepEqual(
    calls.filter((call) => call.id).map((call) => call.id),
    [oldId],
  );
});
