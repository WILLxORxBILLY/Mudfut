import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { state } from "./runtime.mjs";
import { memoryStore } from "./memory.mjs";
import { pilotStore, sourceRecord, emptyMemory, deliver, validateScope } from "./pilot-store.mjs";
import {
  archiveInput,
  refreshSources,
  archiveTool,
  retryRead,
  discordRead,
  startTyping,
  currentSources,
} from "./pilot-discord.mjs";
import { retryableFailure } from "./pilot-supervisor.mjs";
import { pollLiveChannels, liveSource } from "./pilot-live-channels.mjs";
import { timingTrace } from "./pilot-timing.mjs";
import { digest } from "./pilot-store.mjs";
import {
  encodeUnderstanding,
  decodeUnderstanding,
  reviseUnderstanding,
  selectUnderstanding,
  understandingStore,
} from "./pilot-memory.mjs";

const config = {
  guildId: "111111111111111111",
  channelId: "222222222222222222",
  historyScope: [],
};
const message = (id, content = "Friday at seven") => ({
  id,
  content,
  channel_id: config.channelId,
  author: { id: "333333333333333333", username: "Test member" },
  timestamp: "2026-10-15T17:00:00Z",
  type: 0,
});
const a = "555555555555555501",
  b = "555555555555555502",
  c = "555555555555555503";

test("fresh channel pages validate recent sources; absent evidence still gets an exact read", async () => {
  let pages = 0;
  const exact = [];
  const sources = [a, b, c].map((id) => ({ id, channelId: config.channelId }));
  const other = { id: "555555555555555504", channelId: "777777777777777777" };
  let current = message(a, "edited");
  const discord = {
    recent: async (channel, limit) => {
      assert.equal(channel, config.channelId);
      assert.equal(limit, 100);
      pages++;
      return [current];
    },
    get: async (channel, id) => {
      exact.push([channel, id]);
      return id === b || id === other.id ? message(id) : null;
    },
  };
  const first = await currentSources(discord, [...sources, other]);
  assert.equal(first.get(a).content, "edited");
  assert.equal(first.get(b).id, b, "absence from the latest page is not deletion");
  assert.equal(first.get(c), null);
  assert.deepEqual(exact, [
    [config.channelId, b],
    [config.channelId, c],
    [other.channelId, other.id],
  ]);
  current = message(a, "edited again");
  assert.equal((await currentSources(discord, sources)).get(a).content, "edited again");
  assert.equal(pages, 2, "final validation must fetch a new page, never reuse an earlier snapshot");
  assert.equal((await currentSources(discord, [sources[2]])).get(c), null);
  assert.equal(pages, 2, "one source needs only its exact read");
  assert.equal((await currentSources(discord, [])).size, 0);
  await assert.rejects(
    currentSources(
      {
        ...discord,
        recent: async () => {
          throw new Error("forbidden");
        },
      },
      sources,
    ),
    /forbidden/,
  );
  await assert.rejects(
    currentSources(
      {
        ...discord,
        get: async () => {
          throw new Error("outage");
        },
      },
      sources,
    ),
    /outage/,
  );

  const fullPage = Array.from({ length: 12 }, (_, n) => message(String(BigInt(a) + BigInt(n))));
  const bounded = await currentSources(
    {
      recent: async () => fullPage,
      get: async () => assert.fail("no individual read for a source present in the page"),
    },
    fullPage.map((m) => ({ id: m.id, channelId: config.channelId })),
  );
  assert.equal(bounded.size, 12);
});

test("scattered historical validation uses four fresh chronological windows then exact reads; stalled pages and checkpoints remain bounded", async () => {
  const id = (n) => String(BigInt(a) + BigInt(n));
  const selected = [101, 102, 103, 201, 202, 203, 301, 302, 303, 401, 402, 403, 501, 502, 503, 999];
  const refs = [...selected].reverse().map((n) => ({ id: id(n), channelId: config.channelId }));
  const around = [],
    exact = [],
    events = [];
  let version = "first";
  const discord = {
    recent: async () => {
      events.push("recent");
      return [];
    },
    around: async (_channel, anchor) => {
      events.push("around");
      around.push(anchor);
      const cluster = Number((BigInt(anchor) - BigInt(a)) / 100n);
      return [1, 2, 3].map((offset) => message(id(cluster * 100 + offset), version));
    },
    get: async (_channel, value) => {
      events.push("exact");
      exact.push(value);
      return value === id(999) ? null : message(value, version);
    },
  };
  const check = async () => {
    events.push("checkpoint");
  };
  const first = await currentSources(discord, refs, check);
  assert.equal(around.length, 4);
  assert.equal(around[0], id(303), "Median must use chronology rather than incoming source order");
  assert.equal(exact.length, 4);
  assert.equal(first.get(id(999)), null);
  assert.equal(first.size, selected.length, "Unrequested page neighbors must not become evidence");
  assert.ok(
    events.every((event, index) => event === "checkpoint" || events[index - 1] === "checkpoint"),
  );
  version = "edited";
  const second = await currentSources(discord, refs, check);
  assert.equal(around.length, 8, "A later validation cannot reuse historical pages");
  assert.equal(second.get(id(301)).content, "edited");
  let stalled = 0,
    fallback = 0;
  const unresolved = await currentSources(
    {
      recent: async () => [],
      around: async () => {
        stalled++;
        return [message(id(800))];
      },
      get: async () => {
        fallback++;
        return null;
      },
    },
    refs,
  );
  assert.equal(stalled, 1, "No-progress pages must stop the historical loop");
  assert.equal(fallback, selected.length);
  assert.ok([...unresolved.values()].every((value) => value === null));
  let checkpoints = 0,
    reads = 0;
  const preempted = Object.assign(new Error("Live reply arrived"), { code: "HISTORY_PREEMPTED" });
  await assert.rejects(
    currentSources(
      {
        ...discord,
        recent: async () => [],
        around: async () => {
          reads++;
          return [message(id(303))];
        },
      },
      refs,
      async () => {
        if (++checkpoints === 3) throw preempted;
      },
    ),
    (error) => error === preempted,
  );
  assert.equal(reads, 1, "Preemption before the next page prevents any further historical request");
});

test("latency spans retain async results and failures with monotonic durations", async () => {
  const trace = timingTrace({ scope: "check" });
  assert.equal(await trace.measure("context", async () => 42), 42);
  const failure = new Error("failed");
  await assert.rejects(
    trace.measure("delivery", async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(
    trace.event.stages.map((s) => [s.phase, s.success]),
    [
      ["context", true],
      ["delivery", false],
    ],
  );
  assert.ok(trace.event.stages.every((s) => s.durationMs >= 0 && s.offsetMs >= 0));
});

test("unbounded understanding preserves older useful evidence and rejects unsupported patches", () => {
  const source = sourceRecord(
    message(a, "I always take the train. Friday at seven."),
    config.guildId,
    config.channelId,
  );
  const sources = new Map([[a, source]]);
  let previous = { content: encodeUnderstanding([]), revision: digest(encodeUnderstanding([])) };
  const item = (key, importance = 2) => ({
    key,
    kind: "preference",
    subjects: [source.authorId],
    statement: "This member prefers the train.",
    importance,
    evidence: [{ messageId: a, quote: "I always take the train." }],
  });
  const patch = (upsert) => ({
    expectedRevision: previous.revision,
    upsert,
    remove: [],
    observations: [{ messageId: a, decision: "retained", reason: "Useful travel preference" }],
  });
  previous = reviseUnderstanding(
    previous,
    patch([item("older-important", 3)]),
    sources,
    [a],
    "2026-01-01T00:00:00Z",
  );
  for (let n = 0; n < 140; n++) {
    const route = sourceRecord(
      message(String(BigInt(a) + BigInt(n) + 1n), `I prefer train route ${n}.`),
      config.guildId,
      config.channelId,
    );
    sources.set(route.id, route);
    previous = reviseUnderstanding(
      previous,
      patch([
        {
          ...item(`transient-${n}`, 1),
          statement: `This member prefers train route ${n}.`,
          evidence: [{ messageId: route.id, quote: route.content }],
        },
      ]),
      sources,
      [a],
      `2026-10-15T12:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}Z`,
    );
  }
  assert.equal(decodeUnderstanding(previous.content).length, 141);
  assert.ok(decodeUnderstanding(previous.content).some((e) => e.key === "older-important"));
  assert.equal(previous.audit.evicted.length, 0);
  const wrong = item("wrong");
  wrong.evidence[0].quote = "I always fly";
  assert.throws(
    () => reviseUnderstanding(previous, patch([wrong]), sources, [a]),
    /quote a supplied/,
  );
  assert.throws(
    () => reviseUnderstanding(previous, { ...patch([]), observations: [] }, sources, [a]),
    /Missing first-pass/,
  );
  const unrelated = {
    ...source,
    id: b,
    channelId: "777777777777777777",
    authorId: "666666666666666666",
    createdAt: "2025-01-01T00:00:00Z",
    content: "trains are a metaphor",
  };
  sources.set(b, unrelated);
  const association = {
    ...item("bad-association"),
    subjects: [source.authorId, unrelated.authorId],
    evidence: [...item("x").evidence, { messageId: b, quote: unrelated.content }],
  };
  assert.throws(
    () => reviseUnderstanding(previous, patch([association]), sources, [a]),
    /Separate unrelated episodes/,
  );
  const inference = {
    ...item("tentative", 1),
    kind: "inference",
    statement: "The Friday-at-seven remark may describe a travel plan.",
    evidence: [{ messageId: a, quote: "Friday at seven." }],
    distinctClaim: {
      key: "older-important",
      reason:
        "Uncertain schedule interpretation differs from the retained general train preference.",
    },
  };
  previous = reviseUnderstanding(previous, patch([inference]), sources, [a]);
  assert.ok(
    !selectUnderstanding(decodeUnderstanding(previous.content), { includeInferences: false }).some(
      (e) => e.kind === "inference",
    ),
  );
});

test("pilot trust boundaries", () => {
  assert.throws(() => validateScope({ ...config, channelId: "*" }));
  for (const input of [
    {},
    { query: "" },
    { query: "hello", channelId: config.channelId },
    { messageId: a, query: "hi" },
    { messageId: "1 OR 1" },
  ])
    assert.throws(() => archiveInput(input));
  assert.throws(() =>
    sourceRecord({ ...message(a), channel_id: "other" }, config.guildId, config.channelId),
  );
});

test("transient Discord reads retry within a bound; permission failures do not", async () => {
  let calls = 0;
  const events = [];
  const result = await retryRead(
    async () => {
      if (++calls < 3) throw Object.assign(new Error("temporary"), { status: 500 });
      return "current source";
    },
    async (event) => events.push(event),
    async () => {},
  );
  assert.equal(result, "current source");
  assert.equal(events.length, 2);
  calls = 0;
  await assert.rejects(
    retryRead(
      async () => {
        calls++;
        throw Object.assign(new Error("forbidden"), { status: 403 });
      },
      undefined,
      async () => {},
    ),
    /forbidden/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    retryRead(
      async () => {
        calls++;
        throw Object.assign(new Error("outage"), { status: 503 });
      },
      undefined,
      async () => {},
    ),
    /outage/,
  );
  assert.equal(calls, 3);
});

test("source refresh keeps attachment-only context in pilot storage and removes stale text knowledge", async () => {
  const id = "555555555555555504";
  const source = sourceRecord(message(id, ""), config.guildId, config.channelId);
  const calls = { ingest: [], registered: [], removed: [], checked: [] };
  const store = {
    validationSources: async () => [
      { id, source, deleted: false, learnable: true, hash: digest(JSON.stringify(source)) },
    ],
    ingest: async (...args) => calls.ingest.push(args),
    checked: async (sourceId) => calls.checked.push(sourceId),
  };
  const discord = {
    get: async (_channelId, sourceId) => (sourceId === id ? message(id, "") : null),
  };
  await refreshSources(store, discord, async () => {}, [id], undefined, {
    registerSource: async (item) => calls.registered.push(item.id),
    removeSource: async (sourceId) => calls.removed.push(sourceId),
  });
  assert.equal(calls.ingest.length, 1, "the pilot retains the original for conversational context");
  assert.deepEqual(calls.registered, [], "empty content cannot enter a text-evidence projection");
  assert.deepEqual(
    calls.removed,
    [id],
    "old text interpretations cannot survive a source becoming textless",
  );
  assert.deepEqual(calls.checked, [id]);
});

test(
  "durable single writer, interrupted memory/delivery, source edits and deletion",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () => {
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const db = new pg.Client(credentials),
      other = new pg.Client(credentials);
    const directory = await mkdtemp(join(tmpdir(), "mudfut-pilot-check-"));
    const observed = new Map([
      [a, message(a)],
      [b, message(b)],
      [c, message(c)],
    ]);
    const replies = [];
    let loseAcknowledgement = true;
    const discord = {
      get: async (_channel, id) => observed.get(id) ?? null,
      recent: async () => [...observed.values()],
      after: async () => replies,
      send: async (_channel, body) => {
        const reply = {
          id: "555555555555555599",
          author: { id: "bot" },
          message_reference: body.message_reference,
        };
        replies.push(reply);
        if (loseAcknowledgement)
          throw new Error("simulated interruption after Discord accepted send");
        return reply;
      },
    };
    try {
      await db.connect();
      await other.connect();
      const store = await pilotStore(db, config);
      await assert.rejects(pilotStore(other, config), /Another pilot worker/);
      execFileSync("git", ["init", "--quiet", directory]);
      const memory = memoryStore(directory);
      await memory.write({
        content: emptyMemory,
        expectedRevision: (await memory.read()).revision,
      });
      await store.ingest(sourceRecord(message(a), config.guildId, config.channelId), true);
      const first = await store.next();
      assert.equal(first.replyTo, a);
      const candidate = {
        content: emptyMemory + `Friday at seven [${a}].`,
        expectedRevision: (await memory.read()).revision,
      };
      await store.prepare(0, first, candidate, "Seven it is.");
      // Crash after the file rename, before native Git and PG completion.
      await writeFile(join(directory, "community.md"), candidate.content);
      await store.finish(memory);
      assert.equal(
        execFileSync("git", ["-C", directory, "show", "HEAD:community.md"], { encoding: "utf8" }),
        candidate.content,
      );
      await store.finish(memory);
      assert.equal(await store.next(), null);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM pilot_outbox")).rows[0].n, 1);
      await assert.rejects(
        deliver(store, discord, "bot", config.channelId, async () => {}),
        /interruption/,
      );
      assert.equal(replies.length, 1);
      await deliver(store, discord, "bot", config.channelId, async () => {});
      await deliver(store, discord, "bot", config.channelId, async () => {});
      assert.equal(replies.length, 1, "lost acknowledgement must not send another reply");
      assert.equal((await store.context(b)).priorBotReplies.length, 1);
      assert.equal(
        await store.isAddressed(
          { ...sourceRecord(message(b), config.guildId, config.channelId), replyTo: replies[0].id },
          "444444444444444444",
        ),
        true,
        "a Discord reply to this bot is addressed even without a ping",
      );
      assert.equal(
        (await db.query("SELECT status FROM pilot_outbox WHERE source_id=$1", [a])).rows[0].status,
        "sent",
      );

      await store.ingest(sourceRecord(message(b), config.guildId, config.channelId), true);
      const second = await store.next();
      await store.prepare(
        0,
        second,
        {
          content: (await memory.read()).content,
          expectedRevision: (await memory.read()).revision,
        },
        "Another reply",
      );
      await store.finish(memory);
      // Crash BEFORE HTTP write is indistinguishable from a lost acknowledgement.
      await db.query("UPDATE pilot_outbox SET status='sending' WHERE source_id=$1", [b]);
      await deliver(
        store,
        { ...discord, after: async () => [] },
        "bot",
        config.channelId,
        async () => {},
      );
      assert.equal(
        (await db.query("SELECT status FROM pilot_outbox WHERE source_id=$1", [b])).rows[0].status,
        "held",
      );
      assert.equal(replies.length, 1);

      await store.ingest(sourceRecord(message(c), config.guildId, config.channelId), true);
      const third = await store.next();
      await store.prepare(
        0,
        third,
        {
          content: (await memory.read()).content,
          expectedRevision: (await memory.read()).revision,
        },
        "Never deliver stale",
      );
      observed.set(a, message(a, "Correction: eight, not seven"));
      await refreshSources(store, discord);
      assert.equal((await store.meta()).epoch, 1);
      assert.equal(
        (await store.context(c)).priorBotReplies.length,
        0,
        "old bot replies cannot reintroduce invalidated evidence",
      );
      assert.equal(
        (await db.query("SELECT status FROM pilot_work WHERE reply_to=$1", [c])).rows[0].status,
        "stale",
      );
      await store.reset(memory);
      assert.equal((await memory.read()).content, emptyMemory);
      assert.equal(
        (await store.next()).replyTo,
        c,
        "live replies are selected ahead of quiet rebuild work",
      );
      assert.equal(
        (await archiveTool(store, discord, config, null)({ messageId: a })).sources[0].content,
        "Correction: eight, not seven",
      );
      observed.delete(a);
      const mutations = [];
      await refreshSources(store, discord, async (event) => mutations.push(event));
      assert.deepEqual(mutations, [{ type: "source_mutation", kind: "deleted", sourceId: a }]);
      assert.equal(
        (await archiveTool(store, discord, config, null)({ messageId: a })).sources.length,
        0,
      );
      assert.equal((await store.sources()).find((s) => s.id === a).source.content, null);
      const eligibleBefore = (await store.eligible()).length;
      await store.optOut(message(b).author.id);
      assert.equal((await store.eligible()).length, eligibleBefore);
      await store.ingest(sourceRecord(message(b), config.guildId, config.channelId));
      assert.ok((await store.eligible()).length > 0, "retired opt-out cannot block real sources");
      await db.query("DELETE FROM pilot_optouts");
      await db.query("TRUNCATE pilot_sources,pilot_work,pilot_outbox");
      await db.query("UPDATE pilot_meta SET rebuild=false,relearning=false,invalid_sources='{}'");
      for (let n = 0; n < 205; n++) {
        const id = String(BigInt(a) + BigInt(n));
        await store.ingest(
          sourceRecord(message(id, `Ordinary message ${n}`), config.guildId, config.channelId),
        );
      }
      assert.equal((await store.sources()).length, 205, "message 201 must not stop ingestion");
      assert.ok((await store.validationSources()).length <= 40);
      assert.ok((await store.next()).rows.length <= 12);
      const historical = String(BigInt(a) + 300n);
      observed.set(historical, message(historical, "An unrelated search result"));
      await store.ingest(
        sourceRecord(observed.get(historical), config.guildId, config.channelId),
        false,
        false,
      );
      await archiveTool(store, discord, config, null)({ messageId: historical });
      const cached = (await store.sources()).find((s) => s.id === historical);
      assert.equal(
        cached.learnable,
        false,
        "search hits must not enter the ambient learning queue",
      );
      const structured = understandingStore(directory);
      const entry = (id, key) => ({
        key,
        kind: "statement",
        subjects: [message(id).author.id],
        statement: key,
        importance: 3,
        evidence: [{ messageId: id, quote: "Ordinary" }],
        created: "2026-10-15",
        updated: "2026-10-15",
      });
      await structured.write({
        content: encodeUnderstanding([entry(a, "changed"), entry(b, "preserved")]),
        expectedRevision: (await structured.read()).revision,
      });
      assert.ok(
        !(await readFile(join(directory, "community.md"), "utf8")).includes('"evidence"'),
        "core context must contain only an index, not the unfiltered ledger",
      );
      assert.ok(
        (await readFile(join(directory, "understanding.txt"), "utf8")).includes('"evidence"'),
      );
      await store.remove(a);
      await store.reset(structured);
      assert.deepEqual(
        decodeUnderstanding((await structured.read()).content).map((e) => e.key),
        ["preserved"],
        "mutation must preserve unrelated older understanding",
      );
      loseAcknowledgement = false;
    } finally {
      await other.end();
      await db.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("typing starts immediately, refreshes without overlap, and stops after success or failure", async () => {
  let tick,
    cleared = false,
    calls = 0,
    release;
  const events = [];
  const stop = startTyping(
    {
      typing: async () => {
        calls++;
        if (calls === 1)
          await new Promise((resolve) => {
            release = resolve;
          });
        else throw Object.assign(new Error("unavailable"), { status: 503 });
      },
    },
    config.channelId,
    async (event) => {
      events.push(event);
    },
    {
      setInterval(fn, ms) {
        assert.equal(ms, 8000);
        tick = fn;
        return 1;
      },
      clearInterval(id) {
        assert.equal(id, 1);
        cleared = true;
      },
    },
  );
  assert.equal(calls, 1);
  tick();
  assert.equal(calls, 1);
  release();
  await new Promise(setImmediate);
  tick();
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.deepEqual(
    events.map((e) => e.type),
    ["discord_typing", "discord_typing_failed"],
  );
  stop();
  tick();
  assert.equal(cleared, true);
  assert.equal(calls, 2);
});

test("Discord GET timeouts retry within bounds and remain recoverable after exhaustion", async () => {
  let attempts = 0;
  const aborted = new DOMException("This operation was aborted", "AbortError");
  await assert.rejects(
    retryRead(
      () =>
        discordRead(async () => {
          attempts++;
          throw aborted;
        }),
      async () => {},
      async () => {},
    ),
    (error) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.equal(error.cause, aborted);
      assert.equal(retryableFailure(error), true);
      return true;
    },
  );
  assert.equal(attempts, 3);
  const forbidden = Object.assign(new Error("Forbidden"), { status: 403 });
  await assert.rejects(
    discordRead(async () => {
      throw forbidden;
    }),
    (error) => error === forbidden,
  );
  assert.equal(retryableFailure(forbidden), false);
});

test("live channels poll independent cursors and reject cross-channel responses", async () => {
  const second = "222222222222222223";
  const scope = { ...config, replyChannelIds: [config.channelId, second] };
  for (const replyChannelIds of [null, [], [second], [config.channelId, config.channelId], "*"])
    assert.throws(() => validateScope({ ...config, replyChannelIds }));
  const reads = [];
  const meta = { cursors: { [config.channelId]: c, [second]: a } };
  const store = { meta: async () => structuredClone(meta) };
  const discord = {
    after: async (channel, cursor) => {
      reads.push([channel, cursor]);
      return channel === second ? [{ ...message(b), channel_id: second }] : [];
    },
  };
  const messages = await pollLiveChannels(store, discord, scope);
  assert.deepEqual(reads, [
    [config.channelId, c],
    [second, a],
  ]);
  assert.equal(messages[0].id, b, "busy primary channel cannot advance another channel");
  assert.equal(liveSource(messages[0], scope).channelId, second);
  assert.throws(() => liveSource({ ...message(a), channel_id: "999999999999999999" }, scope));
  await assert.rejects(
    pollLiveChannels(store, { ...discord, after: async () => [message(a)] }, scope),
    /different channel/,
  );
  await assert.rejects(
    pollLiveChannels(
      store,
      {
        after: async () => {
          throw new Error("offline");
        },
      },
      scope,
    ),
    /offline/,
  );
  assert.equal(meta.cursors[second], a, "failed polls never commit progress");
});

test(
  "multi-channel durable routing, context, restart and ambiguous delivery",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () => {
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const db = new pg.Client(credentials);
    await db.connect();
    const schema = "routes_" + Date.now();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    const second = "222222222222222223";
    const scope = { ...config, replyChannelIds: [config.channelId, second] };
    try {
      let store = await pilotStore(db, config);
      await store.cursor(c);
      await db.query("SELECT pg_advisory_unlock(1560387,1127029)");
      store = await pilotStore(db, scope);
      assert.equal((await store.meta()).cursors[config.channelId], c);
      assert.equal((await store.meta()).cursors[second], undefined);
      await store.cursor(a, second);
      await store.cursor("555555555555555500", second);
      assert.equal((await store.meta()).cursors[second], a, "cursor cannot move backward");
      await store.ingest(sourceRecord(message(a), config.guildId, config.channelId));
      const sourceB = liveSource({ ...message(b), channel_id: second }, scope);
      await store.ingest(sourceB, true);
      await store.ingest(liveSource({ ...message(c), channel_id: second }, scope), true);
      assert.equal((await store.next()).replyTo, b);
      assert.equal(
        (await store.context(c)).priorMessages.some((s) => s.id === a),
        false,
      );
      assert.equal(
        await store.isAddressed({ ...sourceB, replyTo: a }, "444444444444444444", async () => ({
          id: a,
          channel_id: second,
          author: { id: "444444444444444444" },
        })),
        true,
      );
      await store.queueReply(b, "Reply in second channel");
      const sends = [];
      const discord = {
        send: async (channelId, body) => {
          sends.push({ channelId, body });
          throw new Error("lost acknowledgement");
        },
        after: async (channelId) => {
          assert.equal(channelId, second);
          return [
            {
              id: "555555555555555599",
              author: { id: "bot" },
              message_reference: { message_id: b },
            },
          ];
        },
      };
      await assert.rejects(
        deliver(store, discord, "bot", config.channelId, async () => {}),
        /lost acknowledgement/,
      );
      assert.equal(sends[0].channelId, second);
      assert.equal(sends[0].body.message_reference.channel_id, second);
      await db.query("SELECT pg_advisory_unlock(1560387,1127029)");
      store = await pilotStore(db, scope);
      assert.equal((await store.meta()).cursors[second], a);
      await deliver(store, discord, "bot", config.channelId, async () => {});
      await deliver(store, discord, "bot", config.channelId, async () => {});
      assert.equal(sends.length, 1, "restart reconciles in original channel without resending");
      assert.equal(
        (await store.context("555555555555555598")).priorBotReplies.length,
        0,
        "primary context cannot include other-channel bot replies",
      );
      await store.queueReply(c, "Do not send outside scope");
      await db.query(
        "UPDATE pilot_sources SET source=jsonb_set(source,'{channelId}','\"999999999999999999\"') WHERE id=$1",
        [c],
      );
      await deliver(store, discord, "bot", config.channelId, async () => {});
      assert.equal(
        (await db.query("SELECT status FROM pilot_outbox WHERE source_id=$1", [c])).rows[0].status,
        "held",
      );
      assert.equal(sends.length, 1);
    } finally {
      await db.query("SELECT pg_advisory_unlock(1560387,1127029)");
      await db.query("SET search_path TO public");
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
