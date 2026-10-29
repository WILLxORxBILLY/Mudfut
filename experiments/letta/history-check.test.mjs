import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { state } from "./runtime.mjs";
import { pilotStore, sourceRecord, digest } from "./pilot-store.mjs";
import { currentSources } from "./pilot-discord.mjs";
import {
  historyQueue,
  validateHistoryPass,
  preserveHistoryMemory,
  stageHistoryRequest,
} from "./pilot-history.mjs";

const guildId = "111111111111111111",
  channelId = "222222222222222222",
  old = "777777777777777777";
const config = { guildId, channelId, historyScope: [{ guildId, channelId: old }] };
const ids = ["555555555555555501", "555555555555555502", "555555555555555503"];
const pass = {
  id: "bounded-test",
  episodes: [
    {
      key: "episode",
      label: "Fictional test only",
      guildId,
      channelId: old,
      sourceIds: ids.slice(0, 2),
      contextIds: ids.slice(2),
    },
  ],
};
const message = (id) => ({
  id,
  channel_id: old,
  author: { id: "333333333333333333", username: "Test" },
  type: 0,
  content: "Test conversation",
  timestamp: "2026-10-01T12:00:00Z",
});

test("historical selections retain workload bounds after legacy scope retirement; unsourced rewrites still fail", () => {
  assert.deepEqual(validateHistoryPass(pass, config), pass);
  for (const episode of [
    { ...pass.episodes[0], sourceIds: [...ids, ...ids] },
    { ...pass.episodes[0], sourceIds: [ids[1], ids[0]] },
    {
      ...pass.episodes[0],
      sourceIds: Array.from({ length: 25 }, (_, i) => String(555555555555555501n + BigInt(i))),
      contextIds: [],
    },
  ])
    assert.throws(() => validateHistoryPass({ ...pass, episodes: [episode] }, config));
  assert.equal(
    validateHistoryPass({ ...pass, episodes: [{ ...pass.episodes[0], channelId }] }, config)
      .episodes[0].channelId,
    channelId,
  );
  assert.throws(() =>
    validateHistoryPass({ ...pass, episodes: Array(7).fill(pass.episodes[0]) }, config),
  );
  const audit = { removed: [], evicted: [] };
  preserveHistoryMemory([{ key: "prior" }], { upsert: [{ key: "historical-new" }] }, audit);
  assert.throws(() =>
    preserveHistoryMemory([{ key: "prior" }], { upsert: [{ key: "prior" }] }, audit),
  );
  assert.throws(() => preserveHistoryMemory([], { upsert: [] }, { ...audit, removed: [{}] }));
  assert.throws(() => preserveHistoryMemory([], { upsert: [] }, { ...audit, evicted: [{}] }));
});

test("a fresh historical page resolves a whole window, with exact fallback and no page-only ingestion", async () => {
  let reads = 0,
    version = "original";
  const exact = [];
  const discord = {
    channel: async (id) => ({ id, guild_id: guildId, type: 0 }),
    recent: async () => [],
    around: async (_channel, id) => {
      assert.equal(id, ids[1]);
      reads++;
      return [{ ...message(ids[0]), content: version }, message(ids[2])];
    },
    get: async (_channel, id) => {
      exact.push(id);
      return message(id);
    },
  };
  const refs = ids.slice(0, 2).map((id) => ({ id, channelId: old }));
  assert.equal((await currentSources(discord, refs)).get(ids[0]).content, "original");
  version = "edited";
  const second = await currentSources(discord, refs);
  assert.equal(second.get(ids[0]).content, "edited");
  assert.equal(second.has(ids[2]), false);
  assert.deepEqual(exact, [ids[1], ids[1]]);
  assert.equal(reads, 2);
});

test(
  "historical progress commits with memory, resumes after interruption and never queues a public reply",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () => {
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const admin = new pg.Client(credentials);
    await admin.connect();
    const database = "mudfut_history_check_" + randomUUID().replaceAll("-", "");
    const directory = await mkdtemp(join(tmpdir(), "mudfut-history-"));
    let db;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      db = new pg.Client({ ...credentials, database });
      await db.connect();
      let store = await pilotStore(db, config);
      const observed = new Map(ids.map((id) => [id, message(id)]));
      const unresolvedReplyId = "555555555555555504";
      observed.set(ids[1], {
        ...message(ids[1]),
        type: 19,
        message_reference: { message_id: unresolvedReplyId },
      });
      const discord = {
        channel: async (id) => ({ id, guild_id: guildId, type: 0 }),
        recent: async () => [],
        around: async () => [...observed.values()],
        get: async (_c, id) => observed.get(id) ?? null,
      };
      const archive = {
        query: async (sql, args) => ({
          rows: sql.includes("SELECT m.message_id")
            ? args[2].map((message_id) => ({ message_id }))
            : [],
        }),
      };
      await writeFile(join(directory, "history-pass.json"), JSON.stringify(pass));
      await store.ingest(sourceRecord(message(ids[0]), guildId, old), false, false);
      assert.equal(await store.next(), null, "searchable cache is never ambient learning");
      const queue = () => historyQueue(store, discord, config, directory, async () => {}, archive);
      let runningQueue = queue();
      const batch = await runningQueue.next();
      assert.deepEqual(
        batch.rows.map((r) => r.id),
        ids.slice(0, 2),
      );
      assert.equal(batch.replyTo, null);
      assert.equal(batch.context.surroundingMessages[0].id, ids[2]);
      assert.deepEqual(batch.context.historicalEpisode.unresolvedReplyIds, [unresolvedReplyId]);
      let episode = (await db.query("SELECT * FROM pilot_history_episodes")).rows[0];
      assert.deepEqual(
        episode.read_ids,
        [],
        "selection and loading do not claim reviewed learning",
      );
      let content = "previous memory",
        interrupt = true;
      const memory = {
        read: async () => ({ content, revision: digest(content) }),
        write: async (input) => {
          content = input.content;
          if (interrupt) {
            interrupt = false;
            throw new Error("interrupted after file commit");
          }
        },
      };
      await store.prepare(
        (await store.meta()).epoch,
        batch,
        { content: "previous memory plus historical context", expectedRevision: digest(content) },
        null,
        ids,
      );
      await assert.rejects(store.finish(memory), /interrupted/);
      assert.equal(
        (await db.query("SELECT status FROM pilot_history_episodes")).rows[0].status,
        "queued",
      );
      await db.end();
      db = new pg.Client({ ...credentials, database });
      await db.connect();
      store = await pilotStore(db, config);
      runningQueue = queue();
      await store.finish(memory);
      episode = (await db.query("SELECT * FROM pilot_history_episodes")).rows[0];
      assert.equal(episode.status, "done");
      assert.deepEqual(episode.read_ids, ids.slice(0, 2));
      assert.deepEqual(episode.context_ids, ids.slice(2));
      assert.equal((await db.query("SELECT count(*)::int AS n FROM pilot_outbox")).rows[0].n, 0);
      assert.equal(
        await runningQueue.next(),
        null,
        "completed history does not relearn on restart",
      );
      const secondPass = {
        ...pass,
        id: "second-pass",
        episodes: [{ ...pass.episodes[0], sourceIds: [ids[2]], contextIds: [] }],
      };
      await stageHistoryRequest(directory, secondPass, config);
      await stageHistoryRequest(directory, secondPass, config);
      await assert.rejects(
        stageHistoryRequest(
          directory,
          { ...secondPass, episodes: [{ ...secondPass.episodes[0], label: "conflict" }] },
          config,
        ),
        /different immutable selection/,
      );
      const admitted = await runningQueue.next();
      assert.equal(
        admitted.historyEpisode,
        "second-pass:episode",
        "the same queue admits a new immutable pass without restart",
      );
      assert.deepEqual(
        (await db.query("SELECT read_ids FROM pilot_history_episodes WHERE pass_id='second-pass'"))
          .rows[0].read_ids,
        [],
      );
      await store.prepare(
        (await store.meta()).epoch,
        admitted,
        { content: content + " second pass", expectedRevision: digest(content) },
        null,
        [ids[2]],
      );
      await store.finish(memory);
      assert.equal(await runningQueue.next(), null);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM pilot_outbox")).rows[0].n, 0);
      await store.ingest(
        sourceRecord({ ...message(ids[0]), content: "corrected original" }, guildId, old),
        false,
        false,
      );
      assert.equal(
        (await db.query("SELECT status FROM pilot_history_episodes WHERE pass_id='bounded-test'"))
          .rows[0].status,
        "queued",
        "mutations requeue affected historical context",
      );
      assert.equal(await store.next(), null, "historical edits never enter the ordinary queue");
      await store.optOut("333333333333333333");
      assert.ok(await queue().next(), "retired opt-out cannot erase sources or block history");
      observed.delete(ids[0]);
      observed.delete(ids[1]);
      assert.equal(await queue().next(), null);
      assert.equal(
        (await db.query("SELECT status FROM pilot_history_episodes WHERE pass_id='bounded-test'"))
          .rows[0].status,
        "excluded",
      );
      await writeFile(
        join(directory, "history-pass.json"),
        JSON.stringify({
          ...pass,
          episodes: [{ ...pass.episodes[0], label: "changed selection" }],
        }),
      );
      assert.equal(
        await queue().next(),
        null,
        "conflicting admission is quarantined without stopping the worker",
      );
      assert.deepEqual(
        (await db.query("SELECT manifest FROM pilot_history_passes WHERE id=$1", [pass.id])).rows[0]
          .manifest,
        pass,
      );
      const rejected = (await db.query("SELECT detail FROM pilot_history_admission_failures")).rows;
      assert.equal(rejected.length, 1);
      assert.match(rejected[0].detail.message, /different immutable selection/);
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("memory repair preserves valid context-supported proposals, rejects stale/invalid evidence and requires complete target decisions", async () => {
  const { memoryPatchSession, encodeUnderstanding, decodeUnderstanding } =
    await import("./pilot-memory.mjs");
  const content = encodeUnderstanding([]),
    initial = { content, revision: digest(content) };
  const sources = new Map(ids.map((id) => [id, sourceRecord(message(id), guildId, old)]));
  const entry = (key, id = ids[0]) => ({
    key,
    kind: "statement",
    subjects: ["333333333333333333"],
    statement: "Test said this in October",
    importance: 1,
    evidence: [{ messageId: id, quote: "Test conversation" }],
  });
  const observations = ids
    .slice(0, 2)
    .map((messageId) => ({ messageId, decision: "irrelevant", reason: "No additional claim" }));
  const repair = memoryPatchSession(initial, sources, ids.slice(0, 2));
  const patch = {
    expectedRevision: initial.revision,
    upsert: [
      entry("context", ids[2]),
      { ...entry("bad"), evidence: [{ messageId: ids[0], quote: "invented" }] },
    ],
    remove: [],
    observations: [
      ...observations,
      { messageId: ids[2], decision: "retained", reason: "Context is support" },
    ],
  };
  const failed = repair.apply(patch);
  assert.equal(repair.complete, false);
  assert.equal(repair.draft, initial, "nothing partially applied");
  assert.deepEqual(
    failed.preservedProposals.map((e) => e.key),
    ["context"],
  );
  assert.ok(failed.errors.some((e) => e.includes(ids[2])));
  assert.ok(failed.errors.some((e) => e.includes("bad")));
  repair.apply({ ...patch, expectedRevision: "0", upsert: [entry("stale")] });
  const duplicate = repair.apply({
    expectedRevision: initial.revision,
    upsert: [],
    remove: [],
    observations: [observations[0], observations[0]],
  });
  assert.equal(repair.complete, false);
  assert.ok(duplicate.errors.some((e) => e.includes(ids[0])));
  const unsupported = repair.apply({
    expectedRevision: initial.revision,
    upsert: [],
    remove: [],
    observations: observations.map((e) => ({ ...e, decision: "retained" })),
  });
  assert.ok(unsupported.errors.some((e) => e.includes(ids[0])));
  const repaired = repair.apply({
    expectedRevision: initial.revision,
    upsert: [entry("fixed")],
    remove: [],
    observations,
  });
  assert.equal(repair.complete, true);
  assert.deepEqual(
    decodeUnderstanding(repair.draft.content)
      .map((e) => e.key)
      .sort(),
    ["context", "fixed"],
  );
  assert.equal(repaired.changed.length, 2);
  assert.equal(initial.content, content);
  const missing = repair.apply({
    expectedRevision: repair.draft.revision,
    upsert: [],
    remove: [],
    observations: [],
  });
  assert.equal(repair.complete, false, "a later invalid write cannot silently complete the turn");
  assert.match(missing.errors[0], /Missing first-pass/);
});

test("historical repair cannot replace older understanding and withdrawals are explicit", async () => {
  const { memoryPatchSession, encodeUnderstanding, decodeUnderstanding } =
    await import("./pilot-memory.mjs");
  const source = sourceRecord(message(ids[0]), guildId, old);
  const proposal = {
    key: "prior",
    kind: "statement",
    subjects: [source.authorId],
    statement: "Existing understanding",
    importance: 2,
    evidence: [{ messageId: source.id, quote: source.content }],
  };
  const original = { ...proposal, created: "2026-01-01", updated: "2026-01-01" };
  const content = encodeUnderstanding([original]),
    initial = { content, revision: digest(content) };
  const repair = memoryPatchSession(
    initial,
    new Map([[source.id, source]]),
    [source.id],
    (patch, audit) => preserveHistoryMemory([original], patch, audit),
  );
  const patch = {
    expectedRevision: initial.revision,
    upsert: [proposal, { ...proposal, key: "new", statement: "Another useful supported detail" }],
    remove: [],
    observations: [],
  };
  const unreviewedOverlap = repair.apply(patch);
  assert.deepEqual(
    unreviewedOverlap.preservedProposals.map((e) => e.key),
    [],
  );
  assert.match(unreviewedOverlap.errors.join(" "), /distinctClaim/);
  const blankReason = repair.apply({
    ...patch,
    upsert: [
      proposal,
      {
        ...proposal,
        key: "new",
        statement: "Another useful supported detail",
        distinctClaim: { key: "prior", reason: "            " },
      },
    ],
  });
  assert.match(blankReason.errors.join(" "), /distinctClaim/);
  const distinctPatch = {
    ...patch,
    upsert: [
      proposal,
      {
        ...proposal,
        key: "new",
        statement: "Another useful supported detail",
        distinctClaim: {
          key: "prior",
          reason: "This is a separate proposition supported by the same message.",
        },
      },
    ],
  };
  assert.deepEqual(
    repair.apply(distinctPatch).preservedProposals.map((e) => e.key),
    ["new"],
  );
  const result = repair.apply({
    ...distinctPatch,
    upsert: [],
    observations: [
      { messageId: source.id, decision: "retained", reason: "Already supported by older memory" },
    ],
    discardProposals: [{ key: "new", reason: "Duplicates existing understanding" }],
  });
  assert.equal(repair.complete, true);
  assert.equal(result.discardedProposals.length, 1);
  const after = decodeUnderstanding(repair.draft.content);
  assert.deepEqual(after, [original]);
  // The same strict source validation still rejects a deleted source on repair.
  const gone = memoryPatchSession(initial, new Map(), [source.id]);
  assert.equal(gone.apply({ ...patch, observations: [] }).preservedProposals.length, 0);
});

test("shared-source review is limited to new keys; lineage updates remain valid", async () => {
  const { memoryPatchSession, encodeUnderstanding, decodeUnderstanding } =
    await import("./pilot-memory.mjs");
  const originalSource = sourceRecord(
    { ...message(ids[0]), content: "I like tea, and I studied abroad in Germany." },
    guildId,
    old,
  );
  const nextSource = sourceRecord(
    {
      ...message(ids[1]),
      content: "I still like tea.",
      timestamp: "2026-10-02T12:00:00Z",
      type: 19,
      message_reference: { message_id: originalSource.id },
    },
    guildId,
    old,
  );
  const tea = {
    key: "tea-preference",
    kind: "preference",
    subjects: [originalSource.authorId],
    statement: "They like tea.",
    importance: 1,
    evidence: [{ messageId: originalSource.id, quote: "I like tea" }],
    created: "2026-10-01T12:00:00Z",
    updated: "2026-10-01T12:00:00Z",
  };
  const study = {
    key: "study-abroad",
    kind: "statement",
    subjects: [originalSource.authorId],
    statement: "They studied abroad in Germany.",
    importance: 1,
    evidence: [{ messageId: originalSource.id, quote: "I studied abroad in Germany" }],
    created: "2026-10-01T12:00:00Z",
    updated: "2026-10-01T12:00:00Z",
  };
  const { created: _created, updated: _updated, ...teaProposal } = tea;
  const content = encodeUnderstanding([tea, study]);
  const initial = { content, revision: digest(content) };
  const repair = memoryPatchSession(
    initial,
    new Map([
      [originalSource.id, originalSource],
      [nextSource.id, nextSource],
    ]),
    [nextSource.id],
  );
  const updated = repair.apply({
    expectedRevision: initial.revision,
    upsert: [
      {
        ...teaProposal,
        evidence: [...tea.evidence, { messageId: nextSource.id, quote: "I still like tea." }],
        lineage: {
          action: "extend",
          reason: "Adds a later confirmation of the same preference.",
          previousUpdated: tea.updated,
        },
      },
    ],
    remove: [],
    observations: [
      { messageId: nextSource.id, decision: "retained", reason: "Confirms the tea preference." },
    ],
  });
  assert.equal(repair.complete, true, updated.errors?.join("; "));
  assert.equal(updated.changed.length, 1);
  const stored = decodeUnderstanding(repair.draft.content);
  assert.equal(stored.length, 2);
  assert.equal(stored.find((entry) => entry.key === "tea-preference").evidence.length, 2);
  assert.equal(stored.find((entry) => entry.key === "tea-preference").distinctClaim, undefined);
});

test("exact claim clones cannot consume memory capacity; sourced changes stay distinct and provenance remains explicit", async () => {
  const { memoryPatchSession, encodeUnderstanding, decodeUnderstanding, memoryEvidence } =
    await import("./pilot-memory.mjs");
  const source = sourceRecord(message(ids[0]), guildId, old);
  const second = sourceRecord(
    {
      ...message(ids[1]),
      content: "A later changed view",
      type: 19,
      message_reference: { message_id: ids[0] },
    },
    guildId,
    old,
  );
  const entry = {
    key: "existing",
    kind: "statement",
    subjects: [source.authorId],
    statement: "A dated attributed view",
    importance: 1,
    evidence: [{ messageId: source.id, quote: source.content }],
    created: "2026-01-01",
    updated: "2026-01-01",
  };
  const { created, updated, ...proposal } = entry;
  const content = encodeUnderstanding([entry]),
    initial = { content, revision: digest(content) };
  const sources = new Map([
    [source.id, source],
    [second.id, second],
  ]);
  const repair = memoryPatchSession(initial, sources, [source.id], (patch, audit) =>
    preserveHistoryMemory([entry], patch, audit),
  );
  const observations = [
    {
      messageId: source.id,
      decision: "retained",
      reason: "Existing sourced understanding already covers it",
    },
  ];
  const failed = repair.apply({
    expectedRevision: initial.revision,
    upsert: [{ ...proposal, key: "clone", importance: 3 }],
    remove: [],
    observations,
  });
  assert.match(failed.errors[0], /already retained as existing/);
  assert.deepEqual(failed.preservedProposals, []);
  assert.equal(repair.draft, initial);
  const repeatedEvidence = repair.apply({
    expectedRevision: initial.revision,
    upsert: [
      {
        ...proposal,
        key: "clone-repeated",
        evidence: [...proposal.evidence, ...proposal.evidence],
      },
    ],
    remove: [],
    observations,
  });
  assert.match(repeatedEvidence.errors[0], /already retained as existing/);
  repair.apply({ expectedRevision: initial.revision, upsert: [], remove: [], observations });
  assert.equal(repair.complete, true);
  assert.deepEqual(decodeUnderstanding(repair.draft.content), [entry]);
  const changed = repair.apply({
    expectedRevision: repair.draft.revision,
    upsert: [
      { ...proposal, key: "later", evidence: [{ messageId: second.id, quote: second.content }] },
    ],
    remove: [],
    observations,
  });
  assert.equal(
    repair.complete,
    true,
    "same wording with different evidence is not silently merged",
  );
  assert.equal(changed.changed.length, 1);
  assert.deepEqual(
    decodeUnderstanding(repair.draft.content).find((e) => e.key === "existing"),
    entry,
  );
  const refs = memoryEvidence(decodeUnderstanding(repair.draft.content), sources);
  assert.equal(refs.find((r) => r.messageId === second.id).replyTo, source.id);
  const originalRef = refs.find((r) => r.messageId === source.id);
  assert.equal(originalRef.authorId, source.authorId);
  assert.equal(originalRef.url, source.url);
  assert.equal(originalRef.createdAt, source.createdAt);
  assert.equal(
    "replyToAuthorId" in refs.find((r) => r.messageId === second.id),
    false,
    "a reply link must not invent a recipient",
  );
  assert.throws(() => memoryEvidence([entry], new Map()), /changed or disappeared/);
  assert.throws(
    () => memoryEvidence([entry], new Map([[source.id, { ...source, id: second.id }]])),
    /changed or disappeared/,
  );
  assert.throws(
    () => memoryEvidence([entry], new Map([[source.id, { ...source, content: "edited away" }]])),
    /changed or disappeared/,
  );
});

test(
  "manual PostgreSQL selection keeps microseconds and numeric snowflake order",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fileURLToPath } = await import("node:url");
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const admin = new pg.Client(credentials);
    await admin.connect();
    const database = "mudfut_manual_precision_" + randomUUID().replaceAll("-", "");
    const password = randomUUID().replaceAll("-", "");
    const directory = await mkdtemp(join(tmpdir(), "mudfut-manual-precision-"));
    let db,
      roleCreated = false;
    try {
      await admin.query(`CREATE ROLE mudfut_history_reader LOGIN PASSWORD '${password}'`);
      roleCreated = true;
      await admin.query(`CREATE DATABASE ${database}`);
      db = new pg.Client({ ...credentials, database });
      await db.connect();
      await db.query(
        await readFile(new URL("../../docs/archive-schema.sql", import.meta.url), "utf8"),
      );
      await db.query("GRANT SELECT ON messages TO mudfut_history_reader");
      const records = [
        ["88888888888888888", "2025-01-02T00:00:00.000001Z"],
        ["99999999999999999", "2025-01-02T00:00:00.000100Z"],
        ["100000000000000000", "2025-01-02T00:00:00.000100Z"],
        ["100000000000000001", "2025-01-02T00:00:00.000200Z"],
      ];
      for (const [id, at] of records)
        await db.query(
          `INSERT INTO messages(guild_id,channel_id,message_id,created_at,content,author_id,author_display_name,content_hash)
        VALUES($1,$2,$3,$4,'A conversation','333333333333333333','Fictional member',repeat('a',64))`,
          [guildId, old, id, at],
        );
      const selection = {
        id: "precision-window",
        windows: [
          {
            key: "window",
            label: "Precision fixture",
            guildId,
            channelId: old,
            start: "2025-01-02T00:00:00.000100Z",
            end: "2025-01-02T00:00:00.000100Z",
          },
        ],
      };
      await writeFile(join(directory, "pilot.json"), JSON.stringify({ guildId, channelId }), {
        mode: 0o600,
      });
      await writeFile(
        join(directory, "history-postgres.json"),
        JSON.stringify({ ...credentials, database, user: "mudfut_history_reader", password }),
        { mode: 0o600 },
      );
      await writeFile(join(directory, "selection.json"), JSON.stringify(selection), {
        mode: 0o600,
      });
      await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL("./pilot-history-cli.mjs", import.meta.url)),
          "stage",
          join(directory, "selection.json"),
        ],
        { env: { ...process.env, MUDFUT_STATE_DIR: directory } },
      );
      const snapshot = JSON.parse(
        await readFile(join(directory, "history-selection-precision-window.json"), "utf8"),
      );
      assert.deepEqual(snapshot.pass.episodes[0].sourceIds, [records[1][0], records[2][0]]);
      assert.deepEqual(snapshot.pass.episodes[0].contextIds, [records[0][0], records[3][0]]);
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      if (roleCreated) await admin.query("DROP ROLE mudfut_history_reader");
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
