import assert from "node:assert/strict";
import { formatReply, replyCompactionRequest, turnCancellation } from "./pilot-reply-format.mjs";

const link = "https://discord.com/channels/10/20/30";
const original = `An attributed view with qualifications. ${link} ` + "Context. ".repeat(300);
let calls = 0;
const result = await formatReply(original, {
  evidenceWarnings: ["A reply parent and image were unavailable."],
  render: async (request) => {
    calls++;
    assert.equal(request.originalDraft, original);
    assert.equal(request.targetChars, 1200);
    assert.equal(request.maxChars, 2000);
    assert.deepEqual(request.allowedSourceUrls, [link]);
    assert.deepEqual(request.evidenceWarnings, ["A reply parent and image were unavailable."]);
    return `A qualified view; the missing image remains uncertain. ${link}`;
  },
});
assert.equal(calls, 1);
assert.ok(result.includes(link));
const valid = "A concise ordinary reply.";
assert.equal(
  await formatReply(valid, {
    render: () => {
      throw Error("must not call");
    },
  }),
  valid,
);
assert.equal(await formatReply("x".repeat(2000)), "x".repeat(2000));
assert.equal(
  await formatReply(original, { render: async () => "x".repeat(1795) }),
  "x".repeat(1795),
);
assert.equal(await formatReply("Use the https:// prefix."), "Use the https:// prefix.");
for (const invalid of [
  "",
  " ",
  "x".repeat(2001),
  "https://discord.com/channels/10/20/31",
  "https://example.org/invented-source",
  `${link} ${link} ${link}`,
]) {
  let attempts = 0;
  await assert.rejects(
    formatReply(original, {
      render: async () => {
        attempts++;
        return invalid;
      },
    }),
  );
  assert.equal(attempts, 2);
}
for (const invalid of [null, "", 10]) await assert.rejects(formatReply(invalid));
assert.throws(() => replyCompactionRequest(original, [null]), /array of strings/);
const failure = new Error("original rendering failure");
let failedRenderCalls = 0;
await assert.rejects(
  formatReply(original, {
    render: async () => {
      failedRenderCalls++;
      throw failure;
    },
  }),
  (error) => error === failure,
);
assert.equal(failedRenderCalls, 1);
for (const firstReply of [
  "😀".repeat(1001),
  "https://example.org/invented-source",
  `${link} ${link} ${link}`,
]) {
  let attempts = 0;
  const repaired = await formatReply(original, {
    render: async (request) => {
      attempts++;
      assert.equal(request.originalDraft, original);
      assert.deepEqual(request.allowedSourceUrls, [link]);
      if (attempts === 1) {
        assert.equal(request.previousAttempt, undefined);
        return firstReply;
      }
      assert.equal(request.previousAttempt.reply, firstReply);
      assert.equal(request.previousAttempt.utf16Length, firstReply.length);
      assert.ok(request.previousAttempt.validationError);
      assert.match(request.instruction, /UTF-16 code units/);
      return `A concise supported reply. ${link}`;
    },
  });
  assert.equal(attempts, 2);
  assert.equal(repaired, `A concise supported reply. ${link}`);
}
let failedRepairCalls = 0;
await assert.rejects(
  formatReply(original, {
    render: async () => {
      failedRepairCalls++;
      if (failedRepairCalls === 1) return "x".repeat(2001);
      throw failure;
    },
  }),
  (error) => error === failure,
);
assert.equal(failedRepairCalls, 2);
// A preemption/deadline during old-session closure must prevent a new renderer
// session even after the close resolves; cancellation keeps the original cause.
for (const code of ["HISTORY_PREEMPTED", "MODEL_DEADLINE"]) {
  const cancellation = turnCancellation(),
    cause = Object.assign(new Error(code), { code });
  let release,
    newSessions = 0;
  const closing = new Promise((resolve) => {
    release = resolve;
  });
  const rendering = (async () => {
    cancellation.check();
    await closing;
    cancellation.check();
    newSessions++;
  })();
  cancellation.cancel(cause);
  cancellation.cancel(new Error("must not replace first cancellation"));
  release();
  await assert.rejects(rendering, (error) => error === cause);
  assert.equal(newSessions, 0);
}
// A changed URL hidden inside normal Markdown must still fail the literal allowlist.
await assert.rejects(
  formatReply(original, {
    render: async () => "[source](<https://discord.com/channels/10/20/999>)",
  }),
  /new source URL/,
);
assert.equal(
  await formatReply(original, { render: async () => `[source](${link}).` }),
  `[source](${link}).`,
);
const external = "https://example.org/a_(balanced)";
assert.equal(
  await formatReply(original + ` [existing](${external}).`, { render: async () => external }),
  external,
);
await assert.rejects(
  formatReply(original + ` [existing](${external}).`, {
    render: async () => "https://example.org/a_(different)",
  }),
  /new source URL/,
);
console.log(
  "Reply formatting checks passed: at most two bounded rewrites with validation feedback, unchanged valid reply, literal source allowlist, no truncation or render-error retries.",
);
