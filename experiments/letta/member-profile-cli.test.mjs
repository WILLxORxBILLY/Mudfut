import assert from "node:assert/strict";
import test from "node:test";
import { profileCommandArguments, runProfileCommand } from "./member-profile-cli.mjs";

const member = "200000000000000001";
const channel = "300000000000000001";
test("profile maintenance requires an explicit member and channel scope", () => {
  assert.equal(profileCommandArguments(["--help"]).help, true);
  assert.deepEqual(
    profileCommandArguments(["status", "--member", member, "--channels", channel])
      .visibleChannelIds,
    [channel],
  );
  for (const args of [
    ["maintain"],
    ["maintain", "--member", member],
    ["status", "--member", member, "--channels", "all"],
    ["review-apply", "--member", member, "--channels", channel],
    ["maintain", "--member", member, "--channels", channel, "--member", member],
  ])
    assert.throws(() => profileCommandArguments(args));
  assert.equal(
    profileCommandArguments(["review", "--member", member, "--channels", channel, "--batches", "2"])
      .maxBatches,
    2,
  );
  assert.throws(() =>
    profileCommandArguments([
      "review",
      "--member",
      member,
      "--channels",
      channel,
      "--batches",
      "0",
    ]),
  );
  assert.throws(() =>
    profileCommandArguments([
      "status",
      "--member",
      member,
      "--channels",
      channel,
      "--batches",
      "2",
    ]),
  );
});
test("invalid command scope fails before touching either database", async () => {
  const forbidden = { query: () => assert.fail("Invalid scope reached database") };
  await assert.rejects(
    () => runProfileCommand(forbidden, forbidden, { command: "maintain" }),
    /Invalid profile command scope/,
  );
});
