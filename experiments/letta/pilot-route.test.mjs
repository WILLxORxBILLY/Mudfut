import assert from "node:assert/strict";
import { test } from "node:test";
import { routeSwitchPlan, routeSwitchReport } from "./pilot-route.mjs";

const current = {
  guildId: "111111111111111111",
  channelId: "222222222222222222",
  historyScope: [],
};
const target = { guildId: "333333333333333333", channelId: "444444444444444444" };
const safe = {
  config: current,
  meta: { scope: current },
  outbox: [{ status: "sent", count: 2 }],
  work: [{ status: "done", count: 3 }],
};

test("route switch clears only the live route after pending work is safe", () => {
  const plan = routeSwitchPlan(safe, target);
  assert.deepEqual(plan.previous, { guildId: current.guildId, channelId: current.channelId });
  assert.deepEqual(plan.next, target);
  assert.equal(plan.config.historyScope.length, 0);
  assert.equal(plan.changed, true);
  assert.deepEqual(routeSwitchReport(plan), {
    previous: { guildId: current.guildId, channelId: current.channelId },
    next: target,
    changed: true,
    historyScopeCount: 0,
  });
});

test("route switch refuses ambiguous delivery and prepared memory", () => {
  assert.throws(
    () => routeSwitchPlan({ ...safe, outbox: [{ status: "ready", count: 1 }] }, target),
    /no unsent outbox/,
  );
  assert.throws(
    () => routeSwitchPlan({ ...safe, work: [{ status: "prepared", count: 1 }] }, target),
    /no unsent outbox/,
  );
});
