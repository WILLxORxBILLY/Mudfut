import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveRecallReadAllowed,
  recoveryTransport,
  recoverySourceAllowed,
} from "./pilot-recovery.mjs";

// A live reply may cite an original that predates its route's frontier. This
// check stays model-free and database-free on purpose: the recovery-gate suite
// skips unless CHECK_DATABASE=1, so the exemption and every refusal that must
// survive it need a guard in the ordinary `pnpm test` run.
const channelId = "222222222222222222";
const otherRoute = "222222222222222223";
const frontier = "555555555555555550";
const protectedId = "555555555555555501";
const preFrontier = "555555555555555502";
const live = "555555555555555551";
const policy = {
  version: 1,
  phase: "live-only",
  revision: 2,
  baseline: "a".repeat(64),
  protectedSourceIds: [protectedId],
  frontiers: { [channelId]: frontier },
  reason: "Fictional archive-recall gate review",
};

// Serves the shapes readRecoveryPolicy/ownsPilot ask for. An absent policy table
// is ordinary mode; a present but empty one is fail-closed, so the double keeps
// those two distinguishable exactly as the real reader does.
function db(active = policy, owned = true) {
  return {
    query: async (sql) => {
      if (sql.includes("to_regclass"))
        return { rows: [{ name: active ? "pilot_recovery_policy" : null }] };
      if (sql.includes("pg_locks")) return { rows: [{ owned }] };
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: owned }] };
      if (sql.includes("SELECT policy")) return { rows: active ? [{ policy: active }] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}
function transport(counted) {
  const count = async () => {
    counted.n++;
    return {};
  };
  return {
    get: count,
    react: count,
    send: count,
    recent: count,
    after: count,
    typing: count,
    serverTime: () => 1,
  };
}
const calls = () => ({ n: 0 });

test("archive recall admits one exact original only on a released, unprotected route", () => {
  assert.equal(archiveRecallReadAllowed(policy, channelId, preFrontier), true);
  assert.equal(archiveRecallReadAllowed(policy, channelId, live), true);
  assert.equal(archiveRecallReadAllowed(policy, channelId, protectedId), false);
  assert.equal(archiveRecallReadAllowed(policy, otherRoute, preFrontier), false);
  assert.equal(
    archiveRecallReadAllowed({ ...policy, phase: "held" }, channelId, preFrontier),
    false,
  );
  assert.equal(archiveRecallReadAllowed(null, channelId, preFrontier), false);
  assert.equal(archiveRecallReadAllowed(policy, channelId, "123"), false);
  // The strict source rule is unchanged: the frontier still governs intake.
  assert.equal(recoverySourceAllowed(policy, { channelId, id: preFrontier }), false);
  assert.equal(recoverySourceAllowed(policy, { channelId, id: live }), true);
});

test("live-only transport reads a pre-frontier reply parent instead of aborting the cycle", async () => {
  for (const call of [
    (t) => t.get(channelId, preFrontier),
    (t) => t.react(channelId, preFrontier, "fixture"),
    (t) => t.send(channelId, { message_reference: { message_id: preFrontier } }),
  ]) {
    const counted = calls();
    await call(recoveryTransport(db(), transport(counted)));
    assert.equal(counted.n, 1, "the transport callback must run");
  }
});

test("the exemption never widens a protected id, an unreleased route or another phase", async () => {
  const refusals = [
    ["protected id", db(), (t) => t.get(channelId, protectedId)],
    [
      "protected parent",
      db(),
      (t) => t.send(channelId, { message_reference: { message_id: protectedId } }),
    ],
    ["protected reaction", db(), (t) => t.react(channelId, protectedId, "fixture")],
    ["unreleased route", db(), (t) => t.get(otherRoute, preFrontier)],
    [
      "held phase",
      db({ ...policy, phase: "held", frontiers: {} }),
      (t) => t.get(channelId, preFrontier),
    ],
  ];
  for (const [label, context, call] of refusals) {
    const counted = calls();
    await assert.rejects(call(recoveryTransport(context, transport(counted))), /recovery/i);
    assert.equal(counted.n, 0, `${label} must refuse before any external callback`);
  }
});

test("paging stays refused and ownership still precedes every transport call", async () => {
  const counted = calls();
  const gated = recoveryTransport(db(), transport(counted));
  await assert.rejects(gated.recent(channelId), /historical\/default-page reads disabled/);
  await assert.rejects(gated.after(channelId, preFrontier), /route\/frontier not released/);
  assert.equal(counted.n, 0);
  const unowned = recoveryTransport(db(policy, false), transport(counted));
  await assert.rejects(unowned.get(channelId, preFrontier), /owns|ownership/i);
  assert.equal(counted.n, 0);
  // Ordinary mode (no policy table) leaves the transport ungated.
  await recoveryTransport(db(null), transport(counted)).get(channelId, preFrontier);
  assert.equal(counted.n, 1);
});
