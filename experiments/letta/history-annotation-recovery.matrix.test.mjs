import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { state, assertPrivateState } from "./runtime.mjs";
import { digest, pilotStore } from "./pilot-store.mjs";
import { encodeUnderstanding } from "./pilot-memory.mjs";
import {
  communityKnowledge,
  archiveAuthorityDigest,
  annotationsFromUnderstanding,
} from "./community-knowledge.mjs";
import { reconcilePendingHistoryDerivations } from "./community-knowledge-recovery.mjs";

const selectedSlicePacket = process.env.MUDFUT_SELECTED_SLICE_REVIEW;

const guildId = "111111111111111111";
const channelId = "222222222222222222";
const authorId = "333333333333333333";
const authority = {
  host: "127.0.0.1",
  port: 5432,
  database: "synthetic_archive",
  user: "mudfut_history_reader",
};
const source = (id, content) => ({
  id,
  guildId,
  channelId,
  authorId,
  authorName: "Fixture Member",
  content,
  createdAt: "2026-10-16T12:00:00.000Z",
  editedAt: null,
  replyTo: null,
  url: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
});
const manifestFor = (id, key, directId, contextId) => ({
  id,
  schemaVersion: "community-archive-manifest-v1",
  archiveConnectionId: "synthetic-history",
  generation: 1,
  episodes: [
    {
      key,
      label: "Synthetic selected discussion",
      guildId,
      channelId,
      sourceIds: [directId],
      contextIds: [contextId],
    },
  ],
});

async function withDatabase(run) {
  const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
  const admin = new pg.Client(credentials);
  await admin.connect();
  const database = "mudfut_eval_derivation_" + randomUUID().replaceAll("-", "");
  let db;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    db = new pg.Client({ ...credentials, database });
    await db.connect();
    let knowledge = await communityKnowledge(db);
    let store = await pilotStore(db, { guildId, channelId, historyScope: [] });
    const restart = async () => {
      await db.end();
      db = new pg.Client({ ...credentials, database });
      await db.connect();
      knowledge = await communityKnowledge(db);
      store = await pilotStore(db, { guildId, channelId, historyScope: [] });
      return { db, knowledge, store };
    };
    await run({
      get db() {
        return db;
      },
      get knowledge() {
        return knowledge;
      },
      get store() {
        return store;
      },
      restart,
    });
  } finally {
    await db?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
}

async function commitUnprojectedEpisode({ db, knowledge, store, manifest, direct, context }) {
  await knowledge.installManifest(manifest);
  await store.ingest(direct, false, false);
  await store.ingest(context, false, false);
  const episode = manifest.episodes[0];
  const historyEpisode = `${manifest.id}:${episode.key}`;
  const passId = randomUUID();
  await db.query("INSERT INTO pilot_history_passes(id,manifest) VALUES($1,$2::jsonb)", [
    passId,
    { id: passId, episodes: [episode] },
  ]);
  await db.query(
    "INSERT INTO pilot_history_episodes(id,pass_id,manifest) VALUES($1,$2,$3::jsonb)",
    [historyEpisode, passId, episode],
  );
  const content = encodeUnderstanding([
    {
      key: "trip-preference",
      kind: "observation",
      subjects: [authorId],
      statement: "The speaker prefers the train for this trip.",
      evidence: [{ messageId: direct.id, quote: direct.content }],
    },
  ]);
  const memory = {
    content: "baseline-memory",
    revision: digest("baseline-memory"),
    async read() {
      return { content: this.content, revision: this.revision };
    },
    async write({ content: next, expectedRevision }) {
      assert.equal(this.revision, expectedRevision);
      this.content = next;
      this.revision = digest(next);
    },
  };
  const batch = {
    historyEpisode,
    rows: [{ id: direct.id, source: direct }],
    context: { surroundingMessages: [context], correctionRequests: [] },
  };
  const candidate = { content, expectedRevision: memory.revision, audit: [] };
  const binding = await knowledge.bindHistoryProjection({
    manifestId: manifest.id,
    episodeKey: episode.key,
    historyEpisodeId: historyEpisode,
    directSources: [direct],
    contextSources: [context],
    archiveAuthority: archiveAuthorityDigest(manifest.archiveConnectionId, authority),
  });
  const workId = await store.prepare(0, batch, candidate, "quiet history", [], binding);
  assert.deepEqual(await store.finish(memory), { completed: [workId], deferred: [] });
  const durable = (
    await db.query("SELECT status,history_projection FROM pilot_work WHERE id=$1", [workId])
  ).rows[0];
  assert.equal(durable.status, "done");
  assert.equal(durable.history_projection.historyWorkId, workId);
  return { episode, historyEpisode, workId, binding, candidate };
}

const databaseTest = (name, run, options = {}) =>
  test(name, { skip: process.env.CHECK_DATABASE !== "1", ...options }, () => withDatabase(run));

databaseTest(
  "evaluator: committed history survives restart, a newer installed manifest, and duplicate projection",
  async ({ db, knowledge, store, restart }) => {
    const directId = "555555555555555501";
    const contextId = "555555555555555502";
    const older = manifestFor("older-installed", "trip", directId, contextId);
    const direct = source(directId, "I prefer the train for this trip.");
    const context = source(contextId, "We discussed taking the train together.");
    const durable = await commitUnprojectedEpisode({
      db,
      knowledge,
      store,
      manifest: older,
      direct,
      context,
    });

    // Installing a new active selection must not erase older already-bound work.
    const newer = manifestFor(
      "newer-installed",
      "later-trip",
      "555555555555555503",
      "555555555555555504",
    );
    await knowledge.installManifest(newer);
    ({ db, knowledge, store } = await restart());
    const pending = await knowledge.pendingHistoryDerivations({ limit: 1 });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].manifestId, older.id);
    assert.equal(pending[0].workId, durable.workId);

    const loadEpisode = async (episode) => {
      assert.equal(episode.key, "trip");
      return { rows: [{ id: direct.id, source: direct }], context: [context], excluded: [] };
    };
    const recovery = () =>
      reconcilePendingHistoryDerivations(knowledge, {
        loadEpisode,
        archiveAuthority: async (manifest) =>
          archiveAuthorityDigest(manifest.archiveConnectionId, authority),
      });
    const first = await recovery();
    assert.equal(first.status, "derived");
    assert.equal(first.projectedCount, 1);
    assert.deepEqual(await recovery(), { disposition: "idle" });

    const view = await knowledge.view("profile", authorId);
    assert.equal(view.entries.length, 1);
    assert.equal(view.entries[0].interpretation, "The speaker prefers the train for this trip.");
    assert.deepEqual(
      view.entries[0].sources.map((item) => item.sourceId),
      [directId],
    );
    assert.equal(view.entries[0].claims.length, 0);
    assert.deepEqual(durable.binding.sourceIds, [directId]);
    assert.deepEqual(durable.binding.contextIds, [contextId]);
    assert.equal(durable.binding.sourceBindings[contextId].role, "context");
    const state = (
      await db.query("SELECT derivation_status FROM pilot_knowledge_episodes WHERE id=$1", [
        durable.historyEpisode,
      ])
    ).rows[0];
    assert.equal(state.derivation_status, "derived");
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM pilot_knowledge_annotations WHERE status='candidate'",
        )
      ).rows[0].n,
      1,
    );
  },
);

databaseTest(
  "evaluator: exact source/context edits, deletion, and archive-authority changes fail closed",
  async ({ db, knowledge, store, restart }) => {
    const directId = "555555555555555511";
    const contextId = "555555555555555512";
    const selected = manifestFor("source-fence", "trip", directId, contextId);
    const direct = source(directId, "I prefer the train for this trip.");
    const context = source(contextId, "We discussed taking the train together.");
    const durable = await commitUnprojectedEpisode({
      db,
      knowledge,
      store,
      manifest: selected,
      direct,
      context,
    });
    ({ db, knowledge, store } = await restart());

    let loads = 0;
    const changedContext = source(contextId, "The context has been edited after selection.");
    const edited = await reconcilePendingHistoryDerivations(knowledge, {
      loadEpisode: async () => {
        loads++;
        return {
          rows: [{ id: direct.id, source: direct }],
          context: [changedContext],
          excluded: [],
        };
      },
      archiveAuthority: async (manifest) =>
        archiveAuthorityDigest(manifest.archiveConnectionId, authority),
    });
    assert.equal(edited.status, "stale");
    assert.equal(
      (
        await db.query("SELECT derivation_reason FROM pilot_knowledge_episodes WHERE id=$1", [
          durable.historyEpisode,
        ])
      ).rows[0].derivation_reason,
      "selected-source-content-changed",
    );
    assert.equal(loads, 1);
    assert.equal((await knowledge.view("profile", authorId)).entries.length, 0);
    assert.equal(
      (
        await db.query("SELECT derivation_status FROM pilot_knowledge_episodes WHERE id=$1", [
          durable.historyEpisode,
        ])
      ).rows[0].derivation_status,
      "stale",
    );

    const deleteDirectId = "555555555555555521";
    const deleteContextId = "555555555555555522";
    const deletionManifest = manifestFor("source-delete", "trip", deleteDirectId, deleteContextId);
    const deleteDirect = source(deleteDirectId, "I prefer walking for this trip.");
    const deleteContext = source(deleteContextId, "We discussed walking together.");
    const deleted = await commitUnprojectedEpisode({
      db,
      knowledge,
      store,
      manifest: deletionManifest,
      direct: deleteDirect,
      context: deleteContext,
    });
    ({ db, knowledge, store } = await restart());
    const excluded = await reconcilePendingHistoryDerivations(knowledge, {
      loadEpisode: async () => ({
        rows: [],
        context: [deleteContext],
        excluded: [{ id: deleteDirectId, reason: "deleted" }],
      }),
      archiveAuthority: async (manifest) =>
        archiveAuthorityDigest(manifest.archiveConnectionId, authority),
    });
    assert.equal(excluded.status, "excluded");
    assert.equal(
      (
        await db.query("SELECT derivation_reason FROM pilot_knowledge_episodes WHERE id=$1", [
          deleted.historyEpisode,
        ])
      ).rows[0].derivation_reason,
      "selected-source-no-longer-eligible",
    );
    assert.equal((await knowledge.view("profile", authorId)).entries.length, 0);
    assert.equal(
      (
        await db.query("SELECT derivation_status FROM pilot_knowledge_episodes WHERE id=$1", [
          deleted.historyEpisode,
        ])
      ).rows[0].derivation_status,
      "excluded",
    );

    const authorityId = await commitUnprojectedEpisode({
      db,
      knowledge,
      store,
      manifest: manifestFor("authority-fence", "trip", "555555555555555531", "555555555555555532"),
      direct: source("555555555555555531", "I like this route."),
      context: source("555555555555555532", "We talked about this route."),
    });
    ({ db, knowledge, store } = await restart());
    let unexpectedLoad = false;
    const mismatch = await reconcilePendingHistoryDerivations(knowledge, {
      loadEpisode: async () => {
        unexpectedLoad = true;
        throw new Error("must fail before source load");
      },
      archiveAuthority: async () => "0".repeat(64),
    });
    assert.equal(unexpectedLoad, false);
    assert.equal(mismatch.status, "stale");
    assert.equal(
      (
        await db.query("SELECT derivation_reason FROM pilot_knowledge_episodes WHERE id=$1", [
          authorityId.historyEpisode,
        ])
      ).rows[0].derivation_reason,
      "archive-authority-changed",
    );
    assert.equal(
      (
        await db.query("SELECT derivation_status FROM pilot_knowledge_episodes WHERE id=$1", [
          authorityId.historyEpisode,
        ])
      ).rows[0].derivation_status,
      "stale",
    );
  },
);

databaseTest(
  "evaluator: correction lineage fences old replay and derived prose is not source evidence",
  async ({ db, knowledge, store, restart }) => {
    const directId = "555555555555555541";
    const contextId = "555555555555555542";
    const selected = manifestFor("correction-fence", "trip", directId, contextId);
    const direct = source(directId, "I prefer the train for this trip.");
    const context = source(contextId, "We discussed taking the train together.");
    const durable = await commitUnprojectedEpisode({
      db,
      knowledge,
      store,
      manifest: selected,
      direct,
      context,
    });
    ({ db, knowledge, store } = await restart());
    await reconcilePendingHistoryDerivations(knowledge, {
      loadEpisode: async () => ({
        rows: [{ id: direct.id, source: direct }],
        context: [context],
        excluded: [],
      }),
      archiveAuthority: async (manifest) =>
        archiveAuthorityDigest(manifest.archiveConnectionId, authority),
    });

    const annotationId = (await knowledge.view("profile", authorId)).entries[0].annotationId;
    const opened = await knowledge.correct({
      route: "correct",
      guildId,
      channelId,
      sourceId: directId,
      reporterId: authorId,
      note: "The interpretation should be narrower.",
    });
    const revisedEntries = [
      {
        key: "trip-preference",
        kind: "observation",
        subjects: [authorId],
        statement: "The speaker prefers the train only for this trip.",
        evidence: [{ messageId: directId, quote: direct.content }],
      },
    ];
    const revised = annotationsFromUnderstanding(revisedEntries, selected.episodes[0])[0];
    assert.equal(revised.id, annotationId);
    revised.interpretation = revisedEntries[0].statement;
    revised.qualifications = ["This is limited to the selected trip."];
    const correctionWork = await knowledge.prepareAnnotation({
      manifestId: selected.id,
      episodeKey: "trip",
      candidate: revised,
    });
    assert.equal((await knowledge.commitAnnotation(correctionWork)).disposition, "applied");
    assert.deepEqual(
      await knowledge.resolveCorrection({
        correctionId: opened.correctionId,
        disposition: "accepted",
        annotationId,
      }),
      { disposition: "resolved", status: "accepted" },
    );
    ({ db, knowledge, store } = await restart());
    assert.equal(
      (await knowledge.pendingHistoryDerivations({ limit: 1 })).length,
      0,
      "an accepted correction retires the older committed replay before restart recovery can apply it",
    );
    assert.equal(
      (await knowledge.view("profile", authorId)).entries[0].interpretation,
      "The speaker prefers the train only for this trip.",
    );
    assert.equal(
      (
        await db.query("SELECT derivation_status FROM pilot_knowledge_episodes WHERE id=$1", [
          durable.historyEpisode,
        ])
      ).rows[0].derivation_status,
      "stale",
    );

    const derivedOnly = [
      {
        key: "derived-prose",
        kind: "inference",
        subjects: [authorId],
        statement: "A summary with no independently selected original.",
        evidence: [{ messageId: "555555555555555599", quote: "Reporter correction note" }],
      },
    ];
    assert.deepEqual(annotationsFromUnderstanding(derivedOnly, selected.episodes[0]), []);
  },
);

databaseTest(
  "evaluator: candidate digest tampering and unselected automatic episodes fail closed",
  async ({ db, knowledge, store }) => {
    const directId = "555555555555555551";
    const contextId = "555555555555555552";
    const selected = manifestFor("candidate-digest-fence", "trip", directId, contextId);
    const durable = await commitUnprojectedEpisode({
      db,
      knowledge,
      store,
      manifest: selected,
      direct: source(directId, "I prefer the train for this trip."),
      context: source(contextId, "We discussed taking the train together."),
    });
    await db.query(
      "UPDATE pilot_work SET candidate=jsonb_set(candidate,'{content}',to_jsonb($2::text)) WHERE id=$1",
      [durable.workId, encodeUnderstanding([])],
    );
    assert.deepEqual(await knowledge.pendingHistoryDerivations({ limit: 1 }), []);
    assert.equal(
      (
        await db.query(
          "SELECT derivation_status,derivation_reason FROM pilot_knowledge_episodes WHERE id=$1",
          [durable.historyEpisode],
        )
      ).rows[0].derivation_status,
      "stale",
    );
    assert.equal((await knowledge.view("profile", authorId)).entries.length, 0);

    await assert.rejects(
      knowledge.bindHistoryProjection({
        manifestId: "auto-window-42",
        episodeKey: "automatic-episode",
        historyEpisodeId: "auto-window-42:automatic-episode",
        directSources: [source(directId, "I prefer the train for this trip.")],
        contextSources: [source(contextId, "We discussed taking the train together.")],
        archiveAuthority: archiveAuthorityDigest(selected.archiveConnectionId, authority),
      }),
      /unknown/i,
    );
    assert.deepEqual(
      annotationsFromUnderstanding(
        [
          {
            key: "derived-only",
            kind: "inference",
            subjects: [authorId],
            statement: "Derived prose is not a new observation.",
            evidence: [{ messageId: "555555555555555599", quote: "A correction note." }],
          },
        ],
        selected.episodes[0],
      ),
      [],
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM pilot_knowledge_annotations WHERE status='candidate'",
        )
      ).rows[0].n,
      0,
    );
  },
);

databaseTest(
  "evaluator: one preselected memory item replays from exact stored originals without model or sender",
  async ({ db, knowledge, store, restart }) => {
    assertPrivateState(selectedSlicePacket);
    const packet = JSON.parse(await readFile(selectedSlicePacket, "utf8"));
    const selectedManifest = packet.manifests[0].manifest;
    const sourceRows = new Map(packet.sources.map((item) => [item.id, item]));
    const selected = selectedManifest.episodes
      .flatMap((candidateEpisode) =>
        packet.memoryMatches.map((candidateMemory) => ({
          episode: candidateEpisode,
          memory: candidateMemory,
        })),
      )
      .find(({ episode: candidateEpisode, memory: candidateMemory }) => {
        const evidence = candidateMemory.entry?.evidence ?? [];
        if (evidence.length !== 1) return false;
        const messageId = evidence[0].messageId;
        const parentId = sourceRows.get(messageId)?.source.replyTo;
        return (
          candidateEpisode.sourceIds.includes(messageId) &&
          candidateEpisode.sourceIds.includes(parentId) &&
          !candidateEpisode.contextIds.includes(parentId)
        );
      });
    assert.ok(
      selected,
      "the frozen packet must retain a selected memory item with an in-slice reply dependency",
    );
    const { episode } = selected;
    const originals = [...episode.sourceIds, ...episode.contextIds].map((id) => sourceRows.get(id));
    const historicalShape = ({ source }) => ({
      id: source.id,
      guildId: episode.guildId,
      channelId: episode.channelId,
      authorId: source.authorId,
      authorName: typeof source.authorName === "string" ? source.authorName.slice(0, 160) : null,
      content: source.content,
      createdAt: source.createdAt,
      editedAt: source.editedAt ?? null,
      replyTo: source.replyTo ?? null,
      url: `https://discord.com/channels/${episode.guildId}/${episode.channelId}/${source.id}`,
    });
    const direct = originals.slice(0, episode.sourceIds.length).map(historicalShape);
    const context = originals.slice(episode.sourceIds.length).map(historicalShape);
    assert.equal(direct.length, 15);
    assert.equal(context.length, 8);
    assert.ok(originals.every((item) => item && !item.deleted && item.source.content.trim()));
    const selectedMemory = selected.memory;
    assert.ok(selectedMemory, "the selected case must remain from the frozen stored snapshot");
    assert.equal(selectedMemory.entry.evidence.length, 1);
    assert.ok(episode.sourceIds.includes(selectedMemory.entry.evidence[0].messageId));
    const directSource = sourceRows.get(selectedMemory.entry.evidence[0].messageId).source;
    const parentId = directSource.replyTo;
    assert.equal(episode.contextIds.includes(parentId), false);
    assert.equal(episode.sourceIds.includes(parentId), true);
    assert.equal(
      packet.annotations.some(
        (item) =>
          item.episode_id === `${selectedManifest.id}:television` && item.candidate.supersedes,
      ),
      false,
    );

    await knowledge.installManifest(selectedManifest);
    for (const item of [...direct, ...context]) await store.ingest(item, false, false);
    const historyEpisode = `${selectedManifest.id}:${episode.key}`;
    const passId = randomUUID();
    await db.query("INSERT INTO pilot_history_passes(id,manifest) VALUES($1,$2::jsonb)", [
      passId,
      { id: passId, episodes: [episode] },
    ]);
    await db.query(
      "INSERT INTO pilot_history_episodes(id,pass_id,manifest) VALUES($1,$2,$3::jsonb)",
      [historyEpisode, passId, episode],
    );
    const memoryContent = encodeUnderstanding([selectedMemory.entry]);
    const memory = {
      content: "isolated-slice-baseline",
      revision: digest("isolated-slice-baseline"),
      async read() {
        return { content: this.content, revision: this.revision };
      },
      async write({ content: next, expectedRevision }) {
        assert.equal(this.revision, expectedRevision);
        this.content = next;
        this.revision = digest(next);
      },
    };
    const batch = {
      historyEpisode,
      rows: direct.map((item) => ({ id: item.id, source: item })),
      context: { surroundingMessages: context, correctionRequests: [] },
    };
    const candidate = { content: memoryContent, expectedRevision: memory.revision, audit: [] };
    const authorityDigest = archiveAuthorityDigest(selectedManifest.archiveConnectionId, authority);
    const binding = await knowledge.bindHistoryProjection({
      manifestId: selectedManifest.id,
      episodeKey: episode.key,
      historyEpisodeId: historyEpisode,
      directSources: batch.rows.map((item) => item.source),
      contextSources: batch.context.surroundingMessages,
      archiveAuthority: authorityDigest,
    });
    const workId = await store.prepare(0, batch, candidate, "silent isolated replay", [], binding);
    assert.deepEqual(await store.finish(memory), { completed: [workId], deferred: [] });
    ({ db, knowledge, store } = await restart());

    const modelCalls = 0;
    const senderCalls = 0;
    const replay = await reconcilePendingHistoryDerivations(knowledge, {
      loadEpisode: async (selected) => {
        assert.equal(selected.key, episode.key);
        return {
          rows: direct.map((item) => ({ id: item.id, source: item })),
          context,
          excluded: [],
        };
      },
      archiveAuthority: async (manifest) =>
        archiveAuthorityDigest(manifest.archiveConnectionId, authority),
    });
    assert.equal(replay.status, "derived");
    assert.equal(modelCalls, 0, "the coordinator has no model dependency or client");
    assert.equal(senderCalls, 0, "the coordinator has no sender dependency or client");

    const projected = await knowledge.view("profile", selectedMemory.entry.subjects[0]);
    const expectedCandidate = annotationsFromUnderstanding([selectedMemory.entry], episode)[0];
    const entry = projected.entries.find((item) => item.annotationId === expectedCandidate.id);
    assert.ok(entry);
    assert.deepEqual(
      entry.sources.map((item) => item.sourceId),
      [directSource.id],
    );
    assert.deepEqual(
      entry.contextSources.map((item) => item.sourceId),
      [parentId],
    );
    assert.equal(entry.sources[0].sourceRevision, sourceRows.get(directSource.id).revision);
    assert.deepEqual(entry.replyBoundaries, [
      {
        childSourceId: directSource.id,
        parentSourceId: parentId,
        status: "included-context",
        dependencyRecorded: true,
        canonicalPermalink: `https://discord.com/channels/${episode.guildId}/${episode.channelId}/${parentId}`,
      },
    ]);
    const lineage = (
      await db.query(
        "SELECT derivation_status,derivation_binding FROM pilot_knowledge_episodes WHERE id=$1",
        [historyEpisode],
      )
    ).rows[0];
    assert.equal(lineage.derivation_status, "derived");
    assert.equal(
      lineage.derivation_binding.archiveConnectionId,
      selectedManifest.archiveConnectionId,
    );
    assert.equal(
      lineage.derivation_binding.sourceBindings[directSource.id].revision,
      sourceRows.get(directSource.id).revision,
    );
    assert.equal(lineage.derivation_binding.contextIds.length, episode.contextIds.length);
    assert.equal(lineage.derivation_binding.sourceBindings[parentId].role, "direct");
    assert.equal(lineage.derivation_binding.contextIds.includes(parentId), false);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM pilot_knowledge_corrections")).rows[0].n,
      0,
      "this frozen episode has no correction lineage; no new correction was fabricated for the replay",
    );
  },
  { skip: process.env.CHECK_DATABASE !== "1" || !selectedSlicePacket },
);
