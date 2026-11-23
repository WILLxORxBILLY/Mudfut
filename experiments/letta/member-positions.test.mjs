import assert from "node:assert/strict";
import test from "node:test";

import { MEMBER_EVIDENCE_SQL } from "./member-profile-store.mjs";
import {
  applicationProfileRequest,
  callerIdFromBatch,
  memberPositions,
  memberProfileExecute,
  unavailableProfile,
} from "./pilot-profile.mjs";

const guild = "100000000000000001";
const caller = "200000000000000009";
const channel = "300000000000000001";

test("the profile read refuses unresolved visibility before querying", async () => {
  let called = false;
  const result = await memberPositions(
    {
      query: async () => {
        called = true;
        return { rows: [] };
      },
    },
    { guildId: guild },
  );
  assert.equal(called, false);
  assert.equal(result.scope, "unavailable");
  assert.equal(result.coverage.extractionReviewCoverage, "unknown");
});

test("the model cannot supply channel visibility, and the reply author is the caller", async () => {
  assert.throws(
    () =>
      applicationProfileRequest(
        { member: "Ada", visibleChannelIds: [channel] },
        { visibleChannelIds: [channel] },
      ),
    /Invalid member position request/,
  );
  const accepted = applicationProfileRequest(
    { member: "Ada" },
    { visibleChannelIds: [channel], callerId: caller },
  );
  assert.deepEqual(accepted.visibleChannelIds, [channel]);
  const batch = {
    replyTo: "400000000000000002",
    rows: [
      { id: "400000000000000001", source: { authorId: "200000000000000008" } },
      { id: "400000000000000002", source: { authorId: caller } },
    ],
  };
  assert.equal(callerIdFromBatch(batch), caller);
  const seen = [];
  const execute = memberProfileExecute(
    async (request, turn) => {
      seen.push({ request, turn });
      return { scope: "member", request };
    },
    async () => [channel],
    () => caller,
  );
  await execute({ member: "Ada", view: "overview" });
  assert.equal(seen[0].turn.callerId, caller);
  assert.deepEqual(seen[0].turn.visibleChannelIds, [channel]);
  assert.equal(Object.hasOwn(seen[0].request, "visibleChannelIds"), false);
  const hidden = memberProfileExecute(
    async () => assert.fail("hidden failure must not load a profile"),
    async () => {
      throw new Error("discord down");
    },
    () => caller,
  );
  assert.equal((await hidden({ member: "Ada" })).scope, "unavailable");
  assert.equal(unavailableProfile().coverage.visibility, "caller-channels");
});

test("evidence loading is not an even sample", () => {
  assert.doesNotMatch(MEMBER_EVIDENCE_SQL, /rn %|GREATEST/);
  assert.match(MEMBER_EVIDENCE_SQL, /s\.guild_id = \$1/);
  assert.match(MEMBER_EVIDENCE_SQL, /LEFT JOIN v2_source_revisions/);
});
