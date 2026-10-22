import { test } from "node:test";
import assert from "node:assert/strict";
import { abortForDeadline } from "./pilot-deadline-abort.mjs";
import { turnCancellation } from "./pilot-reply-format.mjs";

test("deadline abort absorbs a session-close rejection without losing the deadline cause", async () => {
  const cancellation = turnCancellation(),
    records = [];
  await abortForDeadline(
    cancellation,
    { abort: async () => Promise.reject(new Error("App-server client closed")) },
    async (event) => records.push(event),
    "turn-1",
  );
  assert.throws(() => cancellation.check(), /Model turn deadline exceeded/);
  assert.deepEqual(records, [
    {
      type: "model_deadline_abort_error",
      otid: "turn-1",
      error: "Error: App-server client closed",
    },
  ]);
});
