import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acknowledgments,
  eligibleAcknowledgment,
  validateAcknowledgment,
} from "./pilot-acknowledgment.mjs";

const since = "111111111111111111";
const source = (id = "111111111111111112", age = 0) => ({
  id,
  channelId: "222222222222222222",
  createdAt: new Date(Date.now() - age).toISOString(),
});
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for acknowledgment");
}

test("fresh source is persisted before an idempotent reaction and is deduplicated after restart", async () => {
  let saved,
    calls = 0;
  const options = {
    save: async (value) => {
      saved = structuredClone(value);
    },
    react: async () => {
      assert.equal(saved.items[0].attempts, 1);
      calls++;
    },
    record: async () => {},
  };
  const ack = acknowledgments(options);
  const message = source();
  ack.offer(message, Date.now(), since);
  ack.offer(message, Date.now(), since);
  await until(() => saved?.items[0]?.status === "done");
  assert.equal(calls, 1);
  ack.stop();
  const resumed = acknowledgments({ ...options, initial: saved });
  resumed.offer(message, Date.now(), since);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 1);
  resumed.stop();
});

test("quiet cutoff and stale catch-up do not react; a thread endpoint is eligible", async () => {
  let saved,
    calls = 0;
  const ack = acknowledgments({
    save: async (value) => {
      saved = structuredClone(value);
    },
    react: async (channelId) => {
      assert.equal(channelId, "333333333333333333");
      calls++;
    },
    record: async () => {},
  });
  ack.offer(source(since), Date.now(), since);
  ack.offer(source("111111111111111113", 301000), Date.now(), since);
  ack.offer(
    { ...source("111111111111111114"), channelId: "333333333333333333" },
    Date.now(),
    since,
  );
  await until(() => saved?.items[0]?.status === "done");
  assert.equal(calls, 1);
  assert.equal(saved.items.length, 1);
  ack.stop();
});

test("permission failures are recorded without retries and receipt failures do not throw", async () => {
  let saved,
    calls = 0;
  const events = [];
  const ack = acknowledgments({
    save: async (value) => {
      saved = structuredClone(value);
    },
    react: async () => {
      calls++;
      throw Object.assign(new Error("denied"), { status: 403 });
    },
    record: async (event) => {
      events.push(event);
    },
  });
  ack.offer(source(), Date.now(), since);
  await until(() => saved?.items[0]?.status === "failed");
  assert.equal(calls, 1);
  assert.equal(events.find((e) => e.type === "acknowledgment_failed").status, 403);
  ack.stop();
  const broken = acknowledgments({
    save: async () => {
      throw new Error("disk");
    },
    react: async () => assert.fail(),
    record: async () => {
      throw new Error("audit");
    },
  });
  assert.doesNotThrow(() => broken.offer(source(), Date.now(), since));
  await new Promise((resolve) => setTimeout(resolve, 40));
  broken.stop();
});

test("restart preserves pending attempt budget; malformed receipts and config are rejected", async () => {
  let saved,
    calls = 0;
  const old = {
    version: 1,
    items: [
      {
        id: source().id,
        channelId: source().channelId,
        createdAt: Date.now(),
        attempts: 2,
        nextAt: Date.now(),
        status: "pending",
      },
    ],
  };
  const ack = acknowledgments({
    initial: old,
    save: async (value) => {
      saved = structuredClone(value);
    },
    react: async () => {
      calls++;
      throw Object.assign(new Error("unavailable"), { status: 503 });
    },
    record: async () => {},
  });
  await until(() => saved?.items[0]?.status === "failed");
  assert.equal(calls, 1);
  assert.equal(saved.items[0].attempts, 3);
  ack.stop();
  assert.throws(
    () => acknowledgments({ initial: { version: 1, items: [{}] } }),
    /Invalid acknowledgment/,
  );
  assert.throws(() => validateAcknowledgment({ emojiId: "bad" }), /Invalid acknowledgment/);
});

test("rate-limited work does not delay a new acknowledgment or retry early", async () => {
  let saved;
  const calls = [];
  const ack = acknowledgments({
    save: async (value) => {
      saved = structuredClone(value);
    },
    react: async (_channel, id) => {
      calls.push(id);
      if (id === source().id)
        throw Object.assign(new Error("rate limit"), { status: 429, retryAfterMs: 60000 });
    },
    record: async () => {},
  });
  ack.offer(source(), Date.now(), since);
  await until(() => saved?.items[0]?.nextAt > Date.now() + 50000);
  ack.offer(source("111111111111111115"), Date.now(), since);
  await until(() => saved?.items.some((item) => item.id.endsWith("115") && item.status === "done"));
  assert.deepEqual(calls, [source().id, "111111111111111115"]);
  ack.stop();
});

test("only addressed human messages after quiet bootstrap are eligible", () => {
  const human = { author: { bot: false }, type: 0 };
  const threadReply = { author: { bot: false }, type: 19 };
  const input = { ...source(), content: "<@444444444444444444> hello" };
  const cursors = { [input.channelId]: since };
  assert.equal(eligibleAcknowledgment(human, input, cursors, true), true);
  assert.equal(eligibleAcknowledgment(threadReply, input, cursors, true), true);
  assert.equal(eligibleAcknowledgment(human, input, cursors, false), false);
  assert.equal(eligibleAcknowledgment(human, input, {}, true), false);
  assert.equal(
    eligibleAcknowledgment({ ...human, author: { bot: true } }, input, cursors, true),
    false,
  );
  assert.equal(eligibleAcknowledgment({ ...human, type: 7 }, input, cursors, true), false);
  assert.equal(
    eligibleAcknowledgment(human, { ...input, content: "!knowledge status" }, cursors, true),
    false,
  );
});
