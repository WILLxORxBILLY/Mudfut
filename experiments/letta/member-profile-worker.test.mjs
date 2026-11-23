import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { nativeProfileReviewer, reviewMemberProfile } from "./member-profile-worker.mjs";
import {
  profileReviewBatch,
  reviewedProfilePositions,
  PROFILE_REVIEW_CHARACTERS,
} from "./member-profile-review.mjs";

const guildId = "100000000000000001";
const memberId = "200000000000000001";
const channelId = "300000000000000001";
const hiddenChannel = "300000000000000002";

function row(index, overrides = {}) {
  return {
    guildId,
    memberId,
    channelId,
    statementId: `statement-${index}`,
    revisionId: `revision-${index}`,
    messageId: String(500000000000000000n + BigInt(index)),
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    kind: "exact_quote",
    topic: "housing",
    proposition: "Allow apartments",
    quote: "Allow apartments",
    sourceContent: "Allow apartments",
    freshness: "current",
    extractorVersion: "fictional",
    ...overrides,
  };
}
const decision = (item, overrides = {}) => ({
  statementId: item.statementId,
  disposition: "position",
  concept: "housing-supply",
  claimKey: "permit-apartments",
  proposition: "Favors allowing apartments",
  direction: "support",
  sourceIds: [item.messageId],
  qualifiers: [],
  conditions: [],
  ...overrides,
});
const response = (batch, overrides) => ({
  batchToken: batch.batchToken,
  decisions: batch.statements.map((item) => decision(item, overrides)),
});

function fixture(rows) {
  const state = { rows, reviews: [], saves: 0, maintenance: 0, reads: 0, excluded: [] };
  const persistence = {
    maintainMemberProfile: async () => {
      state.maintenance++;
      return { status: "recorded" };
    },
    ledgerState: async () => ({ ledger: "current" }),
    // Deliberately return ALL rows: the worker must apply scope itself as well.
    loadMemberEvidence: async () => {
      state.reads++;
      return state.rows;
    },
    loadProfileReviews: async () => state.reviews,
    optouts: async () => state.excluded,
    saveProfileReview: async (_writer, input) => {
      state.saves++;
      state.reviews.push(...input.records);
    },
  };
  return {
    state,
    options: {
      writer: {},
      sourceDb: {},
      guildId,
      memberId,
      visibleChannelIds: [channelId],
      persistence,
      review: async (batch) => response(batch),
    },
  };
}

test("worker is bounded, resumes exactly, retains singleton and skips unchanged work", async () => {
  const f = fixture(Array.from({ length: 35 }, (_, index) => row(index + 1)));
  const firstSize = profileReviewBatch({
    member: { id: memberId, guildId },
    statements: f.state.rows,
    maxCharacters: PROFILE_REVIEW_CHARACTERS,
  }).statements.length;
  const first = await reviewMemberProfile(f.options);
  assert.equal(first.processedBatches, 1);
  assert.equal(first.processedStatements, firstSize);
  assert.ok(firstSize > 0 && firstSize <= 32);
  assert.equal(first.pending, 35 - firstSize);
  assert.equal(first.status, "bounded");
  const second = await reviewMemberProfile(f.options);
  assert.equal(second.processedStatements, 35 - firstSize);
  assert.equal(second.pending, 0);
  assert.equal(second.status, "current");
  let invoked = false;
  const unchanged = await reviewMemberProfile({
    ...f.options,
    review: async () => {
      invoked = true;
    },
  });
  assert.equal(invoked, false);
  assert.equal(unchanged.processedBatches, 0);
  assert.equal(f.state.saves, 2);
  assert.equal(unchanged.coverage.corpusComplete, false);
});

test("worker honors a multi-batch ceiling rather than draining the entire member", async () => {
  const f = fixture(Array.from({ length: 70 }, (_, index) => row(index + 1)));
  const firstSize = profileReviewBatch({
    member: { id: memberId, guildId },
    statements: f.state.rows,
    maxCharacters: PROFILE_REVIEW_CHARACTERS,
  }).statements.length;
  const secondSize = profileReviewBatch({
    member: { id: memberId, guildId },
    statements: f.state.rows.slice(firstSize),
    maxCharacters: PROFILE_REVIEW_CHARACTERS,
  }).statements.length;
  const result = await reviewMemberProfile({ ...f.options, maxBatches: 2 });
  assert.equal(result.processedBatches, 2);
  assert.equal(result.processedStatements, firstSize + secondSize);
  assert.equal(result.pending, 70 - firstSize - secondSize);
});

test("explicit no-position is reviewed work, not unseen evidence", async () => {
  const f = fixture([row(1)]);
  const result = await reviewMemberProfile({
    ...f.options,
    review: async (batch) =>
      response(batch, {
        disposition: "no-position",
        concept: null,
        claimKey: null,
        proposition: null,
        direction: "unspecified",
      }),
  });
  assert.equal(result.processedStatements, 1);
  assert.equal(result.pending, 0);
  assert.equal(
    reviewedProfilePositions({ statements: f.state.rows, reviews: f.state.reviews }).positions
      .length,
    0,
  );
});

test("model failure/incomplete output saves nothing and a later attempt resumes", async () => {
  const f = fixture([row(1), row(2)]);
  await assert.rejects(
    () =>
      reviewMemberProfile({
        ...f.options,
        review: async () => {
          throw new Error("temporary model failure");
        },
      }),
    /temporary model failure/,
  );
  assert.equal(f.state.saves, 0);
  await assert.rejects(
    () =>
      reviewMemberProfile({
        ...f.options,
        review: async (batch) => ({ batchToken: batch.batchToken, decisions: [] }),
      }),
    /every batch statement/,
  );
  assert.equal(f.state.saves, 0);
  const retry = await reviewMemberProfile(f.options);
  assert.equal(retry.processedStatements, 2);
  assert.equal(retry.pending, 0);
});

test("edits, deletions and newly pending evidence invalidate an in-flight packet", async () => {
  for (const mutate of [
    (f) => {
      f.state.rows[0].sourceContent = "Oppose apartments";
    },
    (f) => {
      f.state.rows[0].freshness = "deleted";
    },
    (f) => {
      f.state.rows.push(row(100));
    },
  ]) {
    const f = fixture(Array.from({ length: 32 }, (_, index) => row(index + 1)));
    await assert.rejects(
      () =>
        reviewMemberProfile({
          ...f.options,
          review: async (batch) => {
            const answer = response(batch);
            mutate(f);
            return answer;
          },
        }),
      { code: "PROFILE_EVIDENCE_CHANGED" },
    );
    assert.equal(f.state.saves, 0);
  }
});

test("hidden/foreign member evidence cannot enter review or supporting references", async () => {
  const f = fixture([
    row(1),
    row(2, { channelId: hiddenChannel }),
    row(3, { memberId: "200000000000000002" }),
  ]);
  const result = await reviewMemberProfile({
    ...f.options,
    review: async (batch) => {
      assert.deepEqual(
        batch.statements.map((item) => item.statementId),
        ["statement-1"],
      );
      return response(batch);
    },
  });
  assert.equal(result.processedStatements, 1);
  assert.equal(result.coverage.eligibleStatements, 1);
  const rejected = fixture([row(1), row(2, { channelId: hiddenChannel })]);
  await assert.rejects(
    () =>
      reviewMemberProfile({
        ...rejected.options,
        review: async (batch) =>
          response(batch, { sourceIds: [batch.statements[0].messageId, row(2).messageId] }),
      }),
    /Foreign profile review source/,
  );
  assert.equal(rejected.state.saves, 0);
});

test("worker distinguishes blocked oversized evidence and no evidence", async () => {
  const oversized = fixture([row(1, { sourceContent: "x".repeat(PROFILE_REVIEW_CHARACTERS + 1) })]);
  const result = await reviewMemberProfile(oversized.options);
  assert.equal(result.status, "blocked");
  assert.equal(result.pending, 1);
  assert.equal(result.blocked[0].reason, "original-exceeds-budget");
  assert.equal(oversized.state.saves, 0);
  const empty = await reviewMemberProfile(fixture([]).options);
  assert.equal(empty.status, "no-evidence");
  assert.equal(empty.coverage.availableEvidenceReviewed, false);
});

test("installation opt-outs block target maintenance and omit excluded reply parents", async () => {
  const blocked = fixture([row(1)]);
  blocked.state.excluded.push(memberId);
  await assert.rejects(() => reviewMemberProfile(blocked.options), /opted out/);
  assert.equal(blocked.state.maintenance, 0);
  assert.equal(blocked.state.saves, 0);
  const parentId = "200000000000000009";
  const f = fixture([
    row(1, {
      sourceContext: [
        {
          memberId: parentId,
          guildId,
          messageId: "500000000000000099",
          channelId,
          revisionId: "parent-revision",
          content: "Private parent text",
          visible: true,
          freshness: "current",
        },
      ],
    }),
  ]);
  f.state.excluded.push(parentId);
  await reviewMemberProfile({
    ...f.options,
    review: async (batch) => {
      assert.deepEqual(batch.statements[0].sourceContext, []);
      return response(batch);
    },
  });
  const changed = fixture([row(1)]);
  await assert.rejects(
    () =>
      reviewMemberProfile({
        ...changed.options,
        review: async (batch) => {
          changed.state.excluded.push(memberId);
          return response(batch);
        },
      }),
    /opted out/,
  );
  assert.equal(changed.state.saves, 0);
});

test("invalid bounds and pre-aborted runs fail before persistence", async () => {
  const f = fixture([row(1)]);
  for (const maxBatches of [0, Infinity, 101, 1.5])
    await assert.rejects(() => reviewMemberProfile({ ...f.options, maxBatches }), /batch limit/);
  const controller = new AbortController();
  controller.abort(new Error("operator stopped"));
  await assert.rejects(
    () => reviewMemberProfile({ ...f.options, signal: controller.signal }),
    /operator stopped/,
  );
  assert.equal(f.state.maintenance, 0);
  const later = new AbortController();
  await assert.rejects(
    () =>
      reviewMemberProfile({
        ...f.options,
        signal: later.signal,
        review: async (batch) => {
          later.abort(new Error("stop before save"));
          return response(batch);
        },
      }),
    /stop before save/,
  );
  assert.equal(f.state.saves, 0);
});

test("worker signal interrupts a nonresponsive injected reviewer without a late save", async () => {
  const f = fixture([row(1)]);
  const controller = new AbortController();
  let announced;
  const started = new Promise((resolve) => {
    announced = resolve;
  });
  let complete;
  const running = reviewMemberProfile({
    ...f.options,
    signal: controller.signal,
    review: async (batch) => {
      announced();
      return new Promise((resolve) => {
        complete = () => resolve(response(batch));
      });
    },
  });
  await started;
  controller.abort(new Error("stop hung reviewer"));
  await assert.rejects(() => running, /stop hung reviewer/);
  complete();
  await Promise.resolve();
  assert.equal(f.state.saves, 0);
});

async function privateDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "mudfut-profile-worker-"));
  t.after(async () => {
    const trash = join(homedir(), ".Trash");
    await mkdir(trash, { recursive: true, mode: 0o700 });
    const destination = join(trash, basename(directory));
    await rename(directory, destination);
    console.log(`Preserved profile reviewer fixture: ${destination}`);
  });
  return directory;
}

function fakeClient({ mode = "success", started, decide } = {}) {
  const observed = {
    creates: [],
    updates: [],
    options: [],
    sends: [],
    closes: 0,
    sessionCloses: 0,
    aborts: 0,
    inlineCommands: [],
  };
  const client = {
    createAgent: async (input) => {
      observed.creates.push(input);
      return "fictional-review-agent";
    },
    agents: { update: async (...args) => observed.updates.push(args) },
    createSession: (agentId, options) => {
      observed.options.push(options);
      const session = {
        agentId,
        conversationId: "fictional-conversation",
        ready: async () => {},
        sendCommand: async (input) => {
          observed.inlineCommands.push(input);
          return { success: true };
        },
        send: async (input) => {
          observed.sends.push(JSON.parse(input));
        },
        async *stream() {
          started?.();
          if (mode === "hang") {
            await new Promise(() => {});
            return;
          }
          if (mode === "error") {
            yield { type: "result", success: false, error: "fictional provider failed" };
            return;
          }
          if (mode !== "no-submit") {
            const packet = observed.sends.at(-1).batch;
            await options.tools[0].execute("call-one", decide ? decide(packet) : response(packet));
          }
          yield { type: "result", success: true, result: "Reviewed the packet" };
        },
        abort: async () => {
          observed.aborts++;
        },
        close: async () => {
          observed.sessionCloses++;
        },
      };
      return session;
    },
    close: async () => {
      observed.closes++;
    },
  };
  return { client, observed };
}
const packet = () =>
  profileReviewBatch({ member: { id: memberId, guildId }, statements: [row(1)] });

test("native adapter is lazy, uses only its submission tool, and closes every client", async (t) => {
  const directory = await privateDirectory(t);
  const fake = fakeClient();
  let factoryCalls = 0;
  const reviewer = await nativeProfileReviewer({
    directory,
    model: "fictional-provider/fictional-model",
    clientFactory: async () => {
      factoryCalls++;
      return fake.client;
    },
  });
  assert.equal(factoryCalls, 0);
  const pending = reviewer(packet(), {
    reviewedConcepts: [{ concept: "housing-supply", claimKey: "permit-apartments" }],
  });
  await assert.rejects(() => reviewer(packet()), /active batch/);
  const answer = await pending;
  assert.equal(answer.decisions.length, 1);
  assert.equal(factoryCalls, 1);
  assert.equal(fake.observed.creates[0].model, "fictional-provider/fictional-model");
  assert.deepEqual(fake.observed.creates[0].baseTools, []);
  assert.equal(fake.observed.creates[0].memfs, false);
  const options = fake.observed.options[0];
  assert.deepEqual(options.allowedTools, ["submit_profile_review"]);
  assert.deepEqual(options.toolset, { base: "none", include: [] });
  assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(options.skillSources, []);
  assert.equal(options.dreaming.trigger, "off");
  assert.equal((await options.canUseTool("Bash")).behavior, "deny");
  assert.equal((await options.canUseTool("submit_profile_review")).behavior, "allow");
  assert.equal(fake.observed.inlineCommands.length, 1);
  assert.equal(fake.observed.sends[0].reviewedConcepts[0].concept, "housing-supply");
  assert.equal(fake.observed.sessionCloses, 1);
  assert.equal(fake.observed.closes, 1);
  const identity = JSON.parse(
    await readFile(join(directory, "profile-reviewer-agent.json"), "utf8"),
  );
  assert.equal(identity.agentId, "fictional-review-agent");
  assert.equal(identity.kind, "member-profile-reviewer");
  await assert.rejects(() => readFile(join(directory, "pilot-agent.json")), { code: "ENOENT" });
  assert.equal((await stat(join(directory, "profile-reviewer-agent.json"))).mode & 0o077, 0);
  await reviewer.close();
  await assert.rejects(() => reviewer(packet()), /closed/);
});

test("native adapter reuses only separate identity and reconciles a changed model", async (t) => {
  const directory = await privateDirectory(t);
  const first = fakeClient();
  const a = await nativeProfileReviewer({
    directory,
    model: "fictional/first",
    clientFactory: async () => first.client,
  });
  await a(packet());
  await a.close();
  const second = fakeClient();
  const b = await nativeProfileReviewer({
    directory,
    model: "fictional/second",
    clientFactory: async () => second.client,
  });
  await b(packet());
  await b.close();
  assert.equal(second.observed.creates.length, 0);
  assert.equal(second.observed.updates[0][0], "fictional-review-agent");
  assert.equal(second.observed.updates[0][1].model, "fictional/second");
});

test("native adapter refuses a copied pilot identity rather than rewriting that agent", async (t) => {
  const directory = await privateDirectory(t);
  await writeFile(
    join(directory, "profile-reviewer-agent.json"),
    JSON.stringify({
      agentId: "fictional-pilot-agent",
      model: "fictional/model",
    }),
    { mode: 0o600 },
  );
  const fake = fakeClient();
  const reviewer = await nativeProfileReviewer({
    directory,
    model: "fictional/model",
    clientFactory: async () => fake.client,
  });
  await assert.rejects(() => reviewer(packet()), /Invalid profile reviewer identity/);
  assert.equal(fake.observed.creates.length, 0);
  assert.equal(fake.observed.updates.length, 0);
  assert.equal(fake.observed.options.length, 0);
  assert.equal(fake.observed.closes, 1);
  await reviewer.close();
});

test("native malformed/missing submissions fail closed and preserve failure receipts", async (t) => {
  for (const mode of ["no-submit", "error", "malformed"]) {
    const directory = await privateDirectory(t);
    const fake = fakeClient({
      mode: mode === "malformed" ? "success" : mode,
      decide:
        mode === "malformed"
          ? (batch) => ({ batchToken: batch.batchToken, decisions: [] })
          : undefined,
    });
    const reviewer = await nativeProfileReviewer({
      directory,
      model: "fictional/model",
      clientFactory: async () => fake.client,
    });
    await assert.rejects(
      () => reviewer(packet()),
      /complete profile review|fictional provider failed|every batch statement/,
    );
    assert.equal(fake.observed.closes, 1);
    assert.equal(fake.observed.sessionCloses, 1);
    assert.ok(fake.observed.aborts >= 1);
    const receipts = (await readFile(join(directory, "profile-reviewer-receipts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(receipts.at(-1).type, "review-failed");
    assert.equal(receipts.at(-1).stored, false);
    await reviewer.close();
  }
});

test("native deadline aborts/closes a hung session without returning a submission", async (t) => {
  const directory = await privateDirectory(t);
  const fake = fakeClient({ mode: "hang" });
  const reviewer = await nativeProfileReviewer({
    directory,
    model: "fictional/model",
    timeoutMs: 100,
    clientFactory: async () => fake.client,
  });
  await assert.rejects(() => reviewer(packet()), { code: "PROFILE_REVIEW_TIMEOUT" });
  assert.ok(fake.observed.aborts >= 1);
  assert.equal(fake.observed.sessionCloses, 1);
  assert.equal(fake.observed.closes, 1);
  assert.match(
    await readFile(join(directory, "profile-reviewer-receipts.jsonl"), "utf8"),
    /review-failed/,
  );
  await reviewer.close();
});

test("native signal cancellation and concurrent review attempts are bounded", async (t) => {
  const directory = await privateDirectory(t);
  let announce;
  const started = new Promise((resolve) => {
    announce = resolve;
  });
  const fake = fakeClient({ mode: "hang", started: announce });
  const reviewer = await nativeProfileReviewer({
    directory,
    model: "fictional/model",
    clientFactory: async () => fake.client,
  });
  const controller = new AbortController();
  const running = reviewer(packet(), { signal: controller.signal });
  await started;
  await assert.rejects(() => reviewer(packet()), /active batch/);
  controller.abort(new Error("operator cancelled"));
  await assert.rejects(() => running, /operator cancelled/);
  assert.equal(fake.observed.closes, 1);
  await reviewer.close();
});
