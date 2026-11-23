import assert from "node:assert/strict";
import test from "node:test";
import { runtimeTurnLimits, runtimeAppServerOptions } from "./runtime.mjs";
import { normalizeModelFailure, recoverableLiveTurn } from "./pilot-generation-failures.mjs";

test("the SDK transport cannot cut off a still-valid application turn", () => {
  assert.equal(runtimeTurnLimits.replyMs, 150_000);
  assert.equal(runtimeTurnLimits.learningMs, 300_000);
  assert.equal(runtimeAppServerOptions.requestTimeoutMs, 330_000);
  for (const budget of [runtimeTurnLimits.replyMs, runtimeTurnLimits.learningMs])
    assert(runtimeAppServerOptions.requestTimeoutMs >= budget + runtimeTurnLimits.transportGraceMs);
  assert.equal(runtimeAppServerOptions.startupTimeoutMs, 60_000);
  assert.equal(runtimeAppServerOptions.pinGlobalAgent, false);
});

test("only known, unprepared live model failures receive a source-local retry", () => {
  const context = {
    phase: "model",
    stopping: false,
    connectionFailure: null,
    batch: { rows: [{ id: "555555555555555551" }] },
  };
  for (const code of [
    "MODEL_TURN_DEADLINE",
    "MODEL_TRANSPORT_TIMEOUT",
    "MODEL_OBSERVATIONS_INCOMPLETE",
  ]) {
    const error = Object.assign(new Error("Fictional model failure"), { code });
    assert.equal(recoverableLiveTurn(error, context), true);
    for (const change of [
      { phase: "commit" },
      { phase: "delivery" },
      { stopping: true },
      { connectionFailure: new Error("Database disconnected") },
      { batch: { rows: [] } },
      { batch: { rows: [{}], historyEpisode: "historical" } },
      { batch: { rows: [{}], operatorRequest: { id: "operator" } } },
    ])
      assert.equal(recoverableLiveTurn(error, { ...context, ...change }), false);
  }
  const timeout = new Error("Timed out waiting for app-server turn");
  assert.equal(normalizeModelFailure(timeout), timeout);
  assert.equal(timeout.code, "MODEL_TRANSPORT_TIMEOUT");
  for (const error of [
    new Error("database timeout"),
    Object.assign(new Error("recovery refusal"), { code: "PILOT_RECOVERY_GATE" }),
    Object.assign(new Error("disk full"), { code: "ENOSPC" }),
  ]) {
    assert.equal(normalizeModelFailure(error), error);
    assert.equal(recoverableLiveTurn(error, context), false);
  }
});
