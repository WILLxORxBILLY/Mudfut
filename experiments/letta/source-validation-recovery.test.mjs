import assert from "node:assert/strict";
import test from "node:test";
import { currentSources, refreshSources } from "./pilot-discord.mjs";
import { sourceRecord, digest } from "./pilot-store.mjs";

const guild = "111111111111111111";
const channel = "222222222222222222";
const message = (id, content = "Fictional original") => ({
  id,
  channel_id: channel,
  author: { id: "333333333333333333", username: "Fixture" },
  content,
  timestamp: "2026-01-01T00:00:00Z",
});
const value = (id) => {
  const source = sourceRecord(message(id), guild, channel);
  return { id, source, hash: digest(JSON.stringify(source)), learnable: true, deleted: false };
};
const first = "555555555555555551",
  second = "555555555555555552";
function fixture() {
  const rows = [value(first), value(second)];
  const held = new Map(),
    checked = [],
    events = [];
  const store = {
    recovery: async () => ({ phase: "live-only" }),
    validationSources: async () => rows,
    isHeld: async (id) => held.has(id),
    quarantineSource: async (row, reason) => held.set(row.id, reason),
    remove: () => assert.fail("Recovery must not delete or rewrite originals"),
    ingest: async (source) => assert.deepEqual(source, rows.find((r) => r.id === source.id).source),
    checked: async (id) => checked.push(id),
  };
  return { store, rows, held, checked, events, record: async (event) => events.push(event) };
}

test("a confirmed missing source is quarantined while unrelated sources still validate", async () => {
  const f = fixture();
  const before = JSON.stringify(f.rows);
  await refreshSources(
    f.store,
    { get: async (_channel, id) => (id === first ? null : message(id)) },
    f.record,
  );
  assert.equal(f.held.get(first), "deleted");
  assert.deepEqual(f.checked, [second]);
  assert.equal(JSON.stringify(f.rows), before);
  assert.equal(f.events[0].type, "source_quarantined");
  assert.equal(f.events[0].sourceId, first);
});

test("an edited source is preserved and held instead of invoking a prohibited rewrite", async () => {
  const f = fixture();
  const before = JSON.stringify(f.rows);
  await refreshSources(
    f.store,
    { get: async (_channel, id) => message(id, id === first ? "Edited original" : undefined) },
    f.record,
  );
  assert.equal(f.held.get(first), "edited");
  assert.equal(JSON.stringify(f.rows), before);
  assert.equal(f.events[0].observedSource.content, "Edited original");
});

test("held sources are not probed again during explicit validation", async () => {
  const f = fixture();
  f.held.set(first, "deleted");
  const read = [];
  await refreshSources(
    f.store,
    {
      get: async (_channel, id) => {
        read.push(id);
        return message(id);
      },
    },
    f.record,
    [first, second],
  );
  assert.deepEqual(read, [second]);
});

test("failed exact reads retain the error and are never interpreted as deletion", async () => {
  for (const code of ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "PILOT_RECOVERY_GATE", 50013]) {
    const failure = Object.assign(new Error("Fictional read failure"), { code });
    await assert.rejects(
      () =>
        currentSources(
          {
            get: async () => {
              throw failure;
            },
          },
          [value(first).source],
          undefined,
          { exactOnly: true },
        ),
      (error) => error === failure,
    );
    const f = fixture();
    await assert.rejects(
      () =>
        refreshSources(
          f.store,
          {
            get: async () => {
              throw failure;
            },
          },
          f.record,
        ),
      (error) => error === failure,
    );
    assert.equal(f.held.size, 0);
  }
});
