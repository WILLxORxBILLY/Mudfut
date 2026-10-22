// Regression checks from the 1d25c24 review; ca54fb4 satisfies these cases.
// Source-hold assertions encode the implemented policy, not the only permitted
// correction design. See COMMUNITY_KNOWLEDGE_REVIEW.md. Use disposable state:
// node experiments/letta/fixture-db.mjs knowledge-review
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { assertPrivateState, state } from "./runtime.mjs";
import {
  canonicalDigest,
  digest,
  pilotStore,
  deliver,
  deliver as deliverPilot,
} from "./pilot-store.mjs";
import { decodeUnderstanding, encodeUnderstanding } from "./pilot-memory.mjs";
import { discordTransport, refreshSources } from "./pilot-discord.mjs";
import { communityKnowledgeEvidence } from "./pilot-reply.mjs";
import {
  communityKnowledge,
  archiveAuthorityDigest,
  annotationsFromUnderstanding,
  manifestDigest,
  parseKnowledgeCommand,
  renderKnowledgeView,
  retrieveCurrentKnowledgeView,
  validateArchiveManifest,
} from "./community-knowledge.mjs";
import { reconcilePendingHistoryDerivations } from "./community-knowledge-recovery.mjs";
import { currentHistoryEpisode } from "./pilot-history.mjs";
import { answerKnowledgeCommand } from "./pilot-knowledge-command.mjs";

const guildId = "111111111111111111";
const channelId = "222222222222222222";
const correctionChannelId = "222222222222222223";
const authorId = "333333333333333333";
const sourceId = "555555555555555501";
const contextId = "555555555555555502";
const commandId = "555555555555555599";
const source = (id = sourceId, content = "I prefer the train for this trip.", replyTo = null) => ({
  id,
  guildId,
  channelId,
  authorId,
  authorName: "Synthetic reviewer",
  content,
  createdAt: "2026-10-16T12:00:00.000Z",
  editedAt: null,
  replyTo,
  url: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
});
const manifest = {
  id: "review-regressions",
  schemaVersion: "community-archive-manifest-v1",
  archiveConnectionId: "synthetic-history",
  generation: 1,
  episodes: [
    {
      key: "trip",
      label: "Synthetic trip discussion",
      guildId,
      channelId,
      sourceIds: [sourceId],
      contextIds: [contextId],
    },
  ],
};
const candidate = (interpretation = "The speaker prefers the train for this trip.") => ({
  id: "trip-preference",
  sourceIds: [sourceId],
  subjectIds: [authorId],
  topics: ["trip"],
  interpretation,
  qualifications: [],
  uncertainty: "low",
  competingWith: [],
  processingVersion: "review-v1",
});
const correction = {
  route: "correct",
  guildId,
  channelId,
  sourceId,
  reporterId: authorId,
  note: "The interpretation overstates this one trip.",
};

async function withDatabase(run) {
  const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
  const admin = new pg.Client(credentials);
  await admin.connect();
  const database = "mudfut_review_" + randomUUID().replaceAll("-", "");
  let db;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    db = new pg.Client({ ...credentials, database });
    await db.connect();
    const knowledge = await communityKnowledge(db);
    await knowledge.installManifest(manifest);
    await knowledge.registerSource(source());
    const prepare = (value = candidate()) =>
      knowledge.prepareAnnotation({
        manifestId: manifest.id,
        episodeKey: "trip",
        candidate: value,
      });
    await run({ db, knowledge, prepare });
  } finally {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
}

async function withRecoveryDatabase(run) {
  const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
  const admin = new pg.Client(credentials);
  await admin.connect();
  const database = "mudfut_recovery_" + randomUUID().replaceAll("-", "");
  let db;
  const config = { guildId, channelId, historyScope: [] };
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    db = new pg.Client({ ...credentials, database });
    await db.connect();
    let knowledge = await communityKnowledge(db);
    let store = await pilotStore(db, config);
    const restart = async () => {
      await db.end();
      db = new pg.Client({ ...credentials, database });
      await db.connect();
      knowledge = await communityKnowledge(db);
      store = await pilotStore(db, config);
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

const recoveryAuthority = {
  host: "127.0.0.1",
  port: 5432,
  database: "synthetic_archive",
  user: "mudfut_history_reader",
};

async function prepareBoundHistoryWork({ db, knowledge, store, id, directId, contextId }) {
  const episode = { ...manifest.episodes[0], sourceIds: [directId], contextIds: [contextId] };
  const boundManifest = { ...manifest, id, episodes: [episode] };
  await knowledge.installManifest(boundManifest);
  const direct = source(directId, "I prefer the train for this trip.");
  const context = source(contextId, "We discussed taking the train together.");
  await store.ingest(direct, false, false);
  await store.ingest(context, false, false);
  const passId = randomUUID();
  await db.query("INSERT INTO pilot_history_passes(id,manifest) VALUES($1,$2::jsonb)", [
    passId,
    { id: passId, episodes: [episode] },
  ]);
  await db.query(
    "INSERT INTO pilot_history_episodes(id,pass_id,manifest) VALUES($1,$2,$3::jsonb)",
    [`${id}:${episode.key}`, passId, episode],
  );
  const content = encodeUnderstanding([
    {
      key: "trip-preference",
      kind: "observation",
      subjects: [authorId],
      statement: "The speaker prefers the train for this trip.",
      evidence: [{ messageId: directId, quote: direct.content }],
    },
  ]);
  const memory = {
    revision: digest("baseline-memory"),
    async read() {
      return { content: this.content ?? "baseline-memory", revision: this.revision };
    },
    async write({ content: next, expectedRevision }) {
      assert.equal(this.revision, expectedRevision);
      this.content = next;
      this.revision = digest(next);
    },
  };
  const batch = {
    historyEpisode: `${id}:${episode.key}`,
    rows: [{ id: directId, source: direct }],
    context: { surroundingMessages: [context], correctionRequests: [] },
  };
  const candidate = { content, expectedRevision: memory.revision, audit: [] };
  const historyProjection = await knowledge.bindHistoryProjection({
    manifestId: id,
    episodeKey: episode.key,
    historyEpisodeId: batch.historyEpisode,
    directSources: [direct],
    contextSources: [context],
    archiveAuthority: archiveAuthorityDigest(boundManifest.archiveConnectionId, recoveryAuthority),
  });
  const workId = await store.prepare(0, batch, candidate, "quiet history", [], historyProjection);
  const finished = await store.finish(memory);
  assert.deepEqual(finished.completed, [workId]);
  return { boundManifest, episode, direct, context, candidate, memory, workId, batch };
}

const databaseTest = (name, run) =>
  test(name, { skip: process.env.CHECK_DATABASE !== "1" }, () => withDatabase(run));

test(
  "R23: a manifest-bound history commit recovers after client restart and replay stays idempotent",
  { skip: process.env.CHECK_DATABASE !== "1" },
  () =>
    withRecoveryDatabase(async (ctx) => {
      const work = await prepareBoundHistoryWork({
        ...ctx,
        id: "recovery-first-manifest",
        directId: "555555555555555601",
        contextId: "555555555555555602",
      });
      const secondEpisode = {
        ...manifest.episodes[0],
        sourceIds: ["555555555555555603"],
        contextIds: [],
      };
      await ctx.knowledge.installManifest({
        ...manifest,
        id: "recovery-active-manifest",
        archiveConnectionId: "different-active-archive",
        episodes: [secondEpisode],
      });
      const pending = await ctx.knowledge.pendingHistoryDerivations();
      assert.equal(pending[0].manifestId, "recovery-first-manifest");
      for (const annotation of annotationsFromUnderstanding(
        decodeUnderstanding(work.candidate.content),
        work.episode,
      )) {
        await ctx.knowledge.commitAnnotation(
          await ctx.knowledge.prepareAnnotation({
            manifestId: "recovery-first-manifest",
            episodeKey: work.episode.key,
            candidate: annotation,
          }),
        );
      }
      const restarted = await ctx.restart();
      const recover = () =>
        reconcilePendingHistoryDerivations(restarted.knowledge, {
          loadEpisode: async () => ({
            rows: [{ source: work.direct }],
            context: [work.context],
            excluded: [],
          }),
          archiveAuthority: async (value) =>
            archiveAuthorityDigest(value.archiveConnectionId, recoveryAuthority),
        });
      const result = await recover();
      assert.equal(result.disposition, "recorded");
      assert.equal(result.status, "derived");
      assert.equal(result.projectedCount, 1);
      assert.equal((await restarted.knowledge.view("topic", "trip")).entries.length, 1);
      assert.equal((await recover()).disposition, "idle");
      const annotations = await restarted.db.query(
        "SELECT count(*)::int AS count FROM pilot_knowledge_annotations WHERE status='candidate'",
      );
      assert.equal(annotations.rows[0].count, 1);
    }),
);

test(
  "R24: an edit to a bound context source fences derivation before projection",
  { skip: process.env.CHECK_DATABASE !== "1" },
  () =>
    withRecoveryDatabase(async (ctx) => {
      const work = await prepareBoundHistoryWork({
        ...ctx,
        id: "recovery-context-edit",
        directId: "555555555555555611",
        contextId: "555555555555555612",
      });
      const result = await reconcilePendingHistoryDerivations(ctx.knowledge, {
        loadEpisode: async () => ({
          rows: [{ source: work.direct }],
          context: [source(work.context.id, "The context was edited after the memory commit.")],
          excluded: [],
        }),
        archiveAuthority: async (value) =>
          archiveAuthorityDigest(value.archiveConnectionId, recoveryAuthority),
      });
      assert.equal(result.status, "stale");
      assert.equal((await ctx.knowledge.view("topic", "trip")).entries.length, 0);
      const status = await ctx.db.query(
        "SELECT derivation_status FROM pilot_knowledge_episodes WHERE id=$1",
        ["recovery-context-edit:trip"],
      );
      assert.equal(status.rows[0].derivation_status, "stale");
    }),
);

test(
  "R24a: an edit to a bound direct source fences derivation before projection",
  { skip: process.env.CHECK_DATABASE !== "1" },
  () =>
    withRecoveryDatabase(async (ctx) => {
      const work = await prepareBoundHistoryWork({
        ...ctx,
        id: "recovery-direct-edit",
        directId: "555555555555555616",
        contextId: "555555555555555617",
      });
      const result = await reconcilePendingHistoryDerivations(ctx.knowledge, {
        loadEpisode: async () => ({
          rows: [{ source: source(work.direct.id, "The original statement was edited.") }],
          context: [work.context],
          excluded: [],
        }),
        archiveAuthority: async (value) =>
          archiveAuthorityDigest(value.archiveConnectionId, recoveryAuthority),
      });
      assert.equal(result.status, "stale");
      assert.equal((await ctx.knowledge.view("topic", "trip")).entries.length, 0);
    }),
);

test(
  "R25: deleting a selected source terminates bound derivation as excluded",
  { skip: process.env.CHECK_DATABASE !== "1" },
  () =>
    withRecoveryDatabase(async (ctx) => {
      const work = await prepareBoundHistoryWork({
        ...ctx,
        id: "recovery-source-delete",
        directId: "555555555555555621",
        contextId: "555555555555555622",
      });
      const result = await reconcilePendingHistoryDerivations(ctx.knowledge, {
        loadEpisode: async () => ({
          rows: [{ source: work.direct }],
          context: [],
          excluded: [{ id: work.context.id, reason: "deleted" }],
        }),
        archiveAuthority: async (value) =>
          archiveAuthorityDigest(value.archiveConnectionId, recoveryAuthority),
      });
      assert.equal(result.status, "excluded");
      assert.equal((await ctx.knowledge.view("topic", "trip")).entries.length, 0);
      const status = await ctx.db.query(
        "SELECT derivation_status FROM pilot_knowledge_episodes WHERE id=$1",
        ["recovery-source-delete:trip"],
      );
      assert.equal(status.rows[0].derivation_status, "excluded");
    }),
);

test(
  "R26: one already-selected real episode binds and renders only in isolated PostgreSQL",
  {
    skip:
      process.env.CHECK_DATABASE !== "1" ||
      !process.env.MUDFUT_REAL_STATE_DIR ||
      !process.env.MUDFUT_REAL_PROOF_OUT,
  },
  () =>
    withRecoveryDatabase(async (ctx) => {
      const privateState = process.env.MUDFUT_REAL_STATE_DIR;
      const privateJson = async (name) => {
        const path = join(privateState, name);
        const file = await (await import("node:fs/promises")).lstat(path);
        assert.ok(file.isFile() && !(file.mode & 0o077), "private input must be mode 600");
        return JSON.parse(await readFile(path, "utf8"));
      };
      const realManifest = validateArchiveManifest(
        await privateJson("community-knowledge-manifest.json"),
      );
      const pilotCredentials = await privateJson("postgres.json");
      const historyCredentials = await privateJson("history-postgres.json");
      const config = await privateJson("pilot.json");
      const discordToken = (await readFile(join(privateState, "discord-token"), "utf8")).trim();
      const liveDb = new pg.Client({ ...pilotCredentials, statement_timeout: 10000 });
      const archiveDb = new pg.Client({ ...historyCredentials, statement_timeout: 10000 });
      let loaded;
      let candidate;
      let episode;
      try {
        await liveDb.connect();
        await liveDb.query("BEGIN READ ONLY");
        try {
          const installed = (
            await liveDb.query(
              "SELECT sha256,generation,manifest FROM pilot_knowledge_manifests WHERE id=$1",
              [realManifest.id],
            )
          ).rows[0];
          assert.ok(installed);
          assert.equal(installed.sha256, manifestDigest(realManifest));
          assert.equal(installed.generation, realManifest.generation);
          assert.equal(manifestDigest(installed.manifest), installed.sha256);
          episode = realManifest.episodes[0];
          const work = (
            await liveDb.query(
              `SELECT candidate,source_ids FROM pilot_work WHERE history_episode=$1 AND status='done'
               ORDER BY created_at DESC LIMIT 1`,
              [`${realManifest.id}:${episode.key}`],
            )
          ).rows[0];
          assert.ok(work, "selected episode must have a committed historical memory candidate");
          assert.deepEqual([...work.source_ids].sort(), [...episode.sourceIds].sort());
          candidate = work.candidate;
          assert.equal(typeof candidate.content, "string");
        } finally {
          await liveDb.query("ROLLBACK");
        }
        assert.equal(historyCredentials.host, "127.0.0.1");
        assert.equal(historyCredentials.user, "mudfut_history_reader");
        await archiveDb.connect();
        loaded = await currentHistoryEpisode(
          discordTransport(discordToken, () => {}),
          archiveDb,
          episode,
        );
      } finally {
        await archiveDb.end().catch(() => {});
        await liveDb.end().catch(() => {});
      }
      assert.ok(loaded);
      assert.equal(loaded.excluded.length, 0, "selected real sources must revalidate as current");
      assert.deepEqual(
        loaded.rows.map((row) => row.id),
        episode.sourceIds,
        "current direct-source order must equal the immutable episode selection",
      );
      assert.deepEqual(
        loaded.context.map((source) => source.id).sort(),
        [...episode.contextIds].sort(),
      );
      const entries = decodeUnderstanding(candidate.content);
      assert.ok(entries);
      const projected = annotationsFromUnderstanding(entries, episode);
      assert.ok(projected.length, "the committed memory candidate must contain eligible evidence");

      await ctx.knowledge.installManifest(realManifest);
      const passId = randomUUID();
      await ctx.db.query("INSERT INTO pilot_history_passes(id,manifest) VALUES($1,$2::jsonb)", [
        passId,
        { id: passId, episodes: [episode] },
      ]);
      await ctx.db.query(
        "INSERT INTO pilot_history_episodes(id,pass_id,manifest) VALUES($1,$2,$3::jsonb)",
        [`${realManifest.id}:${episode.key}`, passId, episode],
      );
      const direct = loaded.rows.map((row) => row.source);
      for (const source of [...direct, ...loaded.context]) {
        await ctx.store.ingest(source, false, false);
        await ctx.knowledge.registerSource(source);
      }
      const batch = {
        historyEpisode: `${realManifest.id}:${episode.key}`,
        rows: loaded.rows,
        context: { surroundingMessages: loaded.context, correctionRequests: [] },
      };
      const binding = await ctx.knowledge.bindHistoryProjection({
        manifestId: realManifest.id,
        episodeKey: episode.key,
        historyEpisodeId: batch.historyEpisode,
        directSources: direct,
        contextSources: loaded.context,
        archiveAuthority: archiveAuthorityDigest(
          realManifest.archiveConnectionId,
          historyCredentials,
        ),
      });
      const memory = {
        revision: candidate.expectedRevision ?? digest(candidate.content),
        async read() {
          return { content: "isolated-baseline", revision: this.revision };
        },
        async write({ content, expectedRevision }) {
          assert.equal(this.revision, expectedRevision);
          this.revision = digest(content);
        },
      };
      const workId = await ctx.store.prepare(
        0,
        batch,
        candidate,
        "isolated history check",
        [],
        binding,
      );
      assert.deepEqual((await ctx.store.finish(memory)).completed, [workId]);
      const committedBinding = (
        await ctx.db.query("SELECT history_projection FROM pilot_work WHERE id=$1", [workId])
      ).rows[0].history_projection;
      assert.equal(committedBinding.memoryCandidateDigest, canonicalDigest(candidate));
      assert.equal(committedBinding.memoryCandidateRevision, digest(candidate.content));
      const restarted = await ctx.restart();
      const outcome = await reconcilePendingHistoryDerivations(restarted.knowledge, {
        loadEpisode: async () => loaded,
        archiveAuthority: async (value) =>
          archiveAuthorityDigest(value.archiveConnectionId, historyCredentials),
      });
      assert.equal(outcome.status, "derived");
      const view = await restarted.knowledge.view("profile", projected[0].subjectIds[0]);
      assert.ok(view.entries.length, "the isolated profile view must be inspectable");
      const rendered = renderKnowledgeView(view);
      assert.match(rendered, /https:\/\/discord\.com\/channels\//);
      assert.ok(rendered.length < 1900);
      const output = process.env.MUDFUT_REAL_PROOF_OUT;
      assertPrivateState(output);
      await writeFile(
        output,
        JSON.stringify(
          {
            kind: "isolated-real-history-derivation-v1",
            manifestId: realManifest.id,
            manifestDigest: manifestDigest(realManifest),
            episodeKey: episode.key,
            episodeDigest: committedBinding.episodeDigest,
            archiveAuthorityDigest: committedBinding.archiveAuthorityDigest,
            selectedDirectCount: direct.length,
            selectedContextCount: loaded.context.length,
            binding: {
              manifestId: committedBinding.manifestId,
              manifestDigest: committedBinding.manifestDigest,
              manifestGeneration: committedBinding.manifestGeneration,
              episodeId: committedBinding.episodeId,
              episodeDigest: committedBinding.episodeDigest,
              archiveConnectionId: committedBinding.archiveConnectionId,
              archiveAuthorityDigest: committedBinding.archiveAuthorityDigest,
              sourceIds: committedBinding.sourceIds,
              contextIds: committedBinding.contextIds,
              sourceDigests: committedBinding.sourceDigests,
              sourceBindings: committedBinding.sourceBindings,
              correctionIds: committedBinding.correctionIds,
              memoryCandidateDigest: committedBinding.memoryCandidateDigest,
              memoryCandidateRevision: committedBinding.memoryCandidateRevision,
              memoryExpectedRevision: committedBinding.memoryExpectedRevision,
            },
            outcome: outcome.status,
            projectedCount: projected.length,
            view: { document: view, rendered },
          },
          null,
          2,
        ) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    }),
);

databaseTest(
  "R1: an open correction rejects a previously prepared candidate",
  async ({ knowledge, prepare }) => {
    await knowledge.commitAnnotation(await prepare());
    const work = await prepare();
    const opened = await knowledge.correct(correction);
    assert.equal((await knowledge.commitAnnotation(work)).disposition, "stale-source");
    const revised = await prepare(
      candidate("The train preference applies to this trip, with the correction noted."),
    );
    assert.equal((await knowledge.commitAnnotation(revised)).disposition, "applied");
    assert.deepEqual(
      await knowledge.resolveCorrection({
        correctionId: opened.correctionId,
        disposition: "accepted",
        annotationId: "trip-preference",
      }),
      { disposition: "resolved", status: "accepted" },
    );
    assert.equal(
      (await knowledge.view("profile", authorId)).entries[0].interpretation,
      "The train preference applies to this trip, with the correction noted.",
    );
  },
);

databaseTest(
  "R2: a replacement PostgreSQL client can revalidate an unchanged source under an open correction",
  async ({ db, knowledge, prepare }) => {
    await knowledge.commitAnnotation(await prepare());
    await knowledge.correct(correction);
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const database = (await db.query("SELECT current_database() AS database")).rows[0].database;
    const replacement = new pg.Client({ ...credentials, database });
    await replacement.connect();
    try {
      const restarted = await communityKnowledge(replacement);
      assert.equal(
        (
          await restarted.commitAnnotation(
            await restarted.prepareAnnotation({
              manifestId: manifest.id,
              episodeKey: "trip",
              candidate: candidate(),
            }),
          )
        ).disposition,
        "applied",
      );
    } finally {
      await replacement.end();
    }
  },
);

databaseTest(
  "R3: revising an annotation leaves only its current revision active",
  async ({ knowledge, prepare }) => {
    await knowledge.commitAnnotation(await prepare());
    await knowledge.commitAnnotation(
      await prepare(candidate("The train preference applies only to this trip.")),
    );
    assert.equal((await knowledge.view("profile", authorId)).entries.length, 1);
  },
);

databaseTest(
  "R4: an older interpretation cannot commit after a newer one with unchanged sources",
  async ({ knowledge, prepare }) => {
    const older = await prepare(candidate("An older interpretation."));
    const newer = await prepare(candidate("A newer qualified interpretation."));
    await knowledge.commitAnnotation(newer);
    assert.equal((await knowledge.commitAnnotation(older)).disposition, "stale-source");
  },
);

databaseTest(
  "R5: exports reject a changed document under an unchanged revision token",
  async ({ knowledge, prepare }) => {
    await knowledge.commitAnnotation(await prepare());
    const exported = await knowledge.prepareExport({ target: "profile", key: authorId });
    exported.document.entries[0].interpretation = "Unsourced replacement prose.";
    assert.notEqual((await knowledge.commitExport(exported)).disposition, "exported");
  },
);

databaseTest(
  "R15: source-revision requeue persists until a fresh episode projection completes",
  async ({ db, knowledge, prepare }) => {
    await knowledge.commitAnnotation(await prepare());
    await knowledge.registerSource(source(sourceId, "I now prefer walking for this trip."));
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const database = (await db.query("SELECT current_database() AS database")).rows[0].database;
    const replacement = new pg.Client({ ...credentials, database });
    await replacement.connect();
    try {
      const restarted = await communityKnowledge(replacement);
      assert.deepEqual(await restarted.requeuedEpisodes(manifest.id), [`${manifest.id}:trip`]);
      assert.deepEqual(
        await restarted.completeRequeuedEpisode({ manifestId: manifest.id, episodeKey: "trip" }),
        { disposition: "completed", episodeId: `${manifest.id}:trip`, retiredJobCount: 1 },
      );
      assert.deepEqual(await restarted.requeuedJobs(manifest.id), []);
    } finally {
      await replacement.end();
    }
  },
);

databaseTest(
  "R20: source deletion leaves its episode durably requeued after a replacement client",
  async ({ db, knowledge, prepare }) => {
    await knowledge.commitAnnotation(await prepare());
    assert.equal(await knowledge.removeSource(sourceId), true);
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const database = (await db.query("SELECT current_database() AS database")).rows[0].database;
    const replacement = new pg.Client({ ...credentials, database });
    await replacement.connect();
    try {
      const restarted = await communityKnowledge(replacement);
      assert.deepEqual(await restarted.requeuedEpisodes(manifest.id), [`${manifest.id}:trip`]);
      assert.deepEqual((await restarted.view("profile", authorId)).entries, []);
      assert.equal((await restarted.requeuedJobs(manifest.id)).length, 1);
    } finally {
      await replacement.end();
    }
  },
);

databaseTest(
  "R21: selected reply parents become context dependencies without becoming child evidence",
  async ({ knowledge, prepare }) => {
    await knowledge.registerSource(source(sourceId, "We named our cat Nimbus.", contextId));
    await knowledge.registerSource(source(contextId, "Nimbus is my favorite fictional character."));
    const work = await prepare();
    assert.deepEqual(work.candidate.sourceIds, [sourceId]);
    assert.deepEqual(work.candidate.contextSourceIds, [contextId]);
    assert.deepEqual(work.sourceIds, [sourceId, contextId]);
    assert.equal((await knowledge.commitAnnotation(work)).disposition, "applied");
    const view = await knowledge.view("profile", authorId);
    assert.equal(view.entries[0].sources[0].replyBoundary.status, "included-context");
    assert.deepEqual(
      view.entries[0].contextSources.map((item) => item.sourceId),
      [contextId],
    );
    assert.deepEqual(view.entries[0].replyBoundaries, [
      {
        childSourceId: sourceId,
        parentSourceId: contextId,
        status: "included-context",
        dependencyRecorded: true,
        canonicalPermalink: source(contextId).url,
      },
    ]);
    assert.match(renderKnowledgeView(view), /claim maps appear only when recorded/i);
    assert.match(renderKnowledgeView(view), /claim-level evidence map not recorded/);
  },
);

databaseTest(
  "R22: external reply parents remain explicit boundaries instead of becoming evidence",
  async ({ knowledge, prepare }) => {
    const externalParentId = "555555555555555503";
    await knowledge.registerSource(
      source(sourceId, "I have watched it for the first time.", externalParentId),
    );
    const work = await prepare();
    assert.equal(work.candidate.contextSourceIds, undefined);
    assert.deepEqual(work.sourceIds, [sourceId]);
    assert.equal((await knowledge.commitAnnotation(work)).disposition, "applied");
    const view = await knowledge.view("profile", authorId);
    assert.deepEqual(view.entries[0].replyBoundaries, [
      {
        childSourceId: sourceId,
        parentSourceId: externalParentId,
        status: "outside-selected-slice",
        dependencyRecorded: false,
        canonicalPermalink: `https://discord.com/channels/${guildId}/${channelId}/${externalParentId}`,
      },
    ]);
    assert.match(renderKnowledgeView(view), /reply parent outside selected evidence/);
    assert.match(renderKnowledgeView(view), new RegExp(externalParentId));
  },
);

databaseTest("R6: held sources cannot be retrieved into new model evidence", async ({ db }) => {
  const store = await pilotStore(db, { guildId, channelId });
  await store.ingest(source());
  await store.holdSource(sourceId);
  assert.deepEqual(await store.findSources([sourceId]), []);
});

databaseTest(
  "R7: correction recovery prevents delivery of a queued old view",
  async ({ db, knowledge, prepare }) => {
    const store = await pilotStore(db, { guildId, channelId });
    await store.ingest(source());
    await store.ingest(source(commandId, "!knowledge topic trip"), false, false);
    await knowledge.commitAnnotation(await prepare());
    await store.queueReply(commandId, renderKnowledgeView(await knowledge.view("topic", "trip")));
    // Simulate an old process dying after durable correction admission but before
    // queued-output invalidation. A replacement adapter must reconcile it before send.
    await db.query(
      "INSERT INTO pilot_knowledge_corrections(id,source_id,source_revision,note_digest,status) VALUES($1,$2,1,$3,'open')",
      [randomUUID(), sourceId, "crash-recovery-note"],
    );
    await communityKnowledge(db);
    const sent = [];
    await deliver(
      store,
      {
        send: async (_channel, value) => {
          sent.push(value);
          return { id: "666666666666666666" };
        },
      },
      "444444444444444444",
      channelId,
      async () => {},
    );
    assert.equal(sent.length, 0);
  },
);

databaseTest(
  "R19: a cited command receipt survives queueing and delivery without source content",
  async ({ db, knowledge, prepare }) => {
    const store = await pilotStore(db, { guildId, channelId });
    await store.ingest(source());
    await store.ingest(source(commandId, "!knowledge topic trip"), false, false);
    await knowledge.commitAnnotation(await prepare());
    const view = await retrieveCurrentKnowledgeView(knowledge, async () => {}, store.findSources, {
      target: "topic",
      topic: "trip",
    });
    const receipt = {
      type: "community_knowledge_command",
      route: "topic",
      knowledgeView: communityKnowledgeEvidence(view),
    };
    await store.queueReply(commandId, renderKnowledgeView(view.document), receipt);
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const database = (await db.query("SELECT current_database() AS database")).rows[0].database;
    const replacement = new pg.Client({ ...credentials, database });
    await replacement.connect();
    try {
      const restartedStore = {
        db: replacement,
        meta: async () => (await replacement.query("SELECT * FROM pilot_meta WHERE id")).rows[0],
      };
      assert.deepEqual(
        (
          await replacement.query("SELECT receipt FROM pilot_outbox WHERE source_id=$1", [
            commandId,
          ])
        ).rows[0].receipt,
        receipt,
      );
      assert.equal(Object.hasOwn(receipt.knowledgeView.candidates[0], "interpretation"), false);
      const events = [];
      await deliver(
        restartedStore,
        { send: async () => ({ id: "666666666666666666" }) },
        "444444444444444444",
        channelId,
        async (event) => events.push(event),
      );
      assert.deepEqual(events[0].receipt, receipt);
    } finally {
      await replacement.end();
    }
  },
);

test(
  "synthetic knowledge command survives restart, context edits and interpretation correction",
  { skip: process.env.CHECK_DATABASE !== "1" },
  () =>
    withRecoveryDatabase(async (ctx) => {
      const config = { guildId, channelId, historyScope: [] };
      const sideId = "555555555555555510";
      const secondCommandId = "555555555555555598";
      const correctionCommandId = "555555555555555597";
      const finalCommandId = "555555555555555596";
      const unchanged = source();
      const initialContext = source(contextId, "We discussed taking the train together.");
      const currentMessages = new Map([
        [sourceId, unchanged],
        [contextId, initialContext],
      ]);
      const asDiscord = (item) => ({
        id: item.id,
        channel_id: item.channelId,
        author: { id: item.authorId, username: item.authorName },
        content: item.content,
        timestamp: item.createdAt,
        ...(item.editedAt ? { edited_timestamp: item.editedAt } : {}),
        ...(item.replyTo ? { message_reference: { message_id: item.replyTo } } : {}),
      });
      const discord = {
        recent: async () => [],
        get: async (_channel, id) => {
          const item = currentMessages.get(id);
          return item ? asDiscord(item) : null;
        },
        send: async (_channel, payload) => {
          sent.push(payload);
          return { id: String(666666666666666600n + BigInt(sent.length)) };
        },
      };
      const sent = [];
      const events = [];
      const makeCandidate = (interpretation, contextQuote) => ({
        ...candidate(interpretation),
        id: "trip-preference",
        kind: "preference",
        contextSourceIds: [contextId],
        sourceQuotes: [{ sourceId, quote: unchanged.content }],
        claims: [
          {
            id: "trip-reading",
            text: interpretation,
            subjectIds: [authorId],
            anchors: [
              { sourceId, quote: unchanged.content, relation: "supports", attributedTo: authorId },
              {
                sourceId: contextId,
                quote: contextQuote,
                relation: "qualifies",
                attributedTo: authorId,
              },
            ],
          },
        ],
      });
      const addCommand = async (id, content) => {
        const item = source(id, content);
        await ctx.store.ingest(item, false, false);
        await ctx.knowledge.registerSource(item);
        return item;
      };
      const readKnowledgeView = (query) =>
        retrieveCurrentKnowledgeView(
          ctx.knowledge,
          (ids) =>
            refreshSources(ctx.store, discord, async () => {}, ids, undefined, ctx.knowledge),
          ctx.store.findSources,
          query,
        );
      const answer = (item) =>
        answerKnowledgeCommand({
          source: item,
          config,
          knowledge: ctx.knowledge,
          discord,
          store: ctx.store,
          readKnowledgeView,
          record: async (event) => events.push(event),
        });
      const deliver = () =>
        deliverPilot(ctx.store, discord, "444444444444444444", channelId, async (event) =>
          events.push(event),
        );

      await ctx.knowledge.installManifest(manifest);
      await ctx.store.ingest(unchanged, false, false);
      await ctx.store.ingest(initialContext, false, false);
      await ctx.knowledge.registerSource(unchanged);
      await ctx.knowledge.registerSource(initialContext);
      assert.equal(
        (
          await ctx.knowledge.commitAnnotation(
            await ctx.knowledge.prepareAnnotation({
              manifestId: manifest.id,
              episodeKey: "trip",
              candidate: makeCandidate(
                "The speaker prefers the train for this trip.",
                initialContext.content,
              ),
            }),
          )
        ).disposition,
        "applied",
      );
      const initialDependencyIds = (
        await ctx.db.query(
          "SELECT source_ids FROM pilot_knowledge_annotations WHERE id=$1 AND status='candidate'",
          ["trip-preference"],
        )
      ).rows[0].source_ids;
      assert.deepEqual(new Set(initialDependencyIds), new Set([sourceId, contextId]));

      const sideManifest = {
        ...manifest,
        id: "integration-unaffected",
        episodes: [
          {
            key: "side",
            label: "Unrelated synthetic evidence",
            guildId,
            channelId,
            sourceIds: [sideId],
            contextIds: [],
          },
        ],
      };
      const sideSource = source(sideId, "The member also collects old maps.");
      await ctx.knowledge.installManifest(sideManifest);
      await ctx.store.ingest(sideSource, false, false);
      await ctx.knowledge.registerSource(sideSource);
      const sideCandidate = {
        id: "map-collection",
        sourceIds: [sideId],
        subjectIds: [authorId],
        topics: ["side"],
        interpretation: "The member also collects old maps.",
        sourceQuotes: [{ sourceId: sideId, quote: sideSource.content }],
        qualifications: [],
        uncertainty: "low",
        competingWith: [],
        processingVersion: "synthetic-command-v1",
      };
      await ctx.knowledge.commitAnnotation(
        await ctx.knowledge.prepareAnnotation({
          manifestId: sideManifest.id,
          episodeKey: "side",
          candidate: sideCandidate,
        }),
      );

      const firstCommand = await addCommand(commandId, "!knowledge topic trip");
      assert.equal(await answer(firstCommand), true);
      const firstQueued = (
        await ctx.db.query("SELECT content,receipt FROM pilot_outbox WHERE source_id=$1", [
          commandId,
        ])
      ).rows[0];
      assert.match(firstQueued.content, /prefers the train for this trip/);
      assert.equal(firstQueued.receipt.knowledgeView.candidates[0].annotationRevision, 1);
      await ctx.restart();
      await deliver();
      assert.equal(sent.length, 1, "a queued knowledge command survives interruption and restart");
      assert.deepEqual(sent[0].allowed_mentions, { parse: [], replied_user: false });

      const staleWork = await ctx.knowledge.prepareAnnotation({
        manifestId: manifest.id,
        episodeKey: "trip",
        candidate: makeCandidate("A stale prepared interpretation.", initialContext.content),
      });
      const delayedExport = await ctx.knowledge.prepareExport({ target: "topic", key: "trip" });
      const editedContext = source(
        contextId,
        "We compared options only; that does not establish a general preference.",
      );
      currentMessages.set(contextId, editedContext);
      await refreshSources(
        ctx.store,
        discord,
        async () => {},
        [contextId],
        undefined,
        ctx.knowledge,
      );
      assert.equal((await ctx.knowledge.commitAnnotation(staleWork)).disposition, "stale-source");
      assert.deepEqual(await ctx.knowledge.commitExport(delayedExport), {
        disposition: "stale-view",
      });
      assert.equal((await ctx.knowledge.view("topic", "trip")).entries.length, 0);
      assert.equal((await ctx.knowledge.view("topic", "side")).entries.length, 1);
      await ctx.restart();
      assert.equal((await ctx.knowledge.view("topic", "side")).entries.length, 1);
      assert.equal(
        (await ctx.knowledge.commitAnnotation(staleWork)).disposition,
        "stale-source",
        "a replacement client cannot revive work prepared against old context",
      );
      await ctx.knowledge.commitAnnotation(
        await ctx.knowledge.prepareAnnotation({
          manifestId: manifest.id,
          episodeKey: "trip",
          candidate: makeCandidate(
            "The discussion compared train options for this trip; broader preference is not established.",
            editedContext.content,
          ),
        }),
      );

      const delayedCorrectionExport = await ctx.knowledge.prepareExport({
        target: "topic",
        key: "trip",
      });
      const correctionText =
        "!knowledge correct https://discord.com/channels/" +
        `${guildId}/${channelId}/${sourceId} This is not a settled preference beyond this trip.`;
      const correctionCommand = await addCommand(correctionCommandId, correctionText);
      assert.equal(await answer(correctionCommand), true);
      assert.deepEqual(await ctx.knowledge.commitExport(delayedCorrectionExport), {
        disposition: "stale-view",
      });
      assert.equal((await ctx.knowledge.view("topic", "side")).entries.length, 1);
      const queuedCorrection = (
        await ctx.db.query("SELECT status,content FROM pilot_outbox WHERE source_id=$1", [
          correctionCommandId,
        ])
      ).rows[0];
      assert.equal(queuedCorrection.status, "ready");
      await ctx.restart();
      await deliver();
      assert.equal(
        (await ctx.db.query("SELECT 1 FROM pilot_outbox WHERE source_id=$1", [correctionCommandId]))
          .rowCount,
        0,
        "correction recovery conservatively withdraws ready output while dependencies are unscoped",
      );
      assert.equal(
        sent.length,
        1,
        "the first command was delivered; the correction invalidation withheld its ack",
      );

      const corrected = makeCandidate(
        "The speaker prefers the train for this trip; this does not establish a broader durable preference.",
        editedContext.content,
      );
      const correctedOutcome = await ctx.knowledge.commitAnnotation(
        await ctx.knowledge.prepareAnnotation({
          manifestId: manifest.id,
          episodeKey: "trip",
          candidate: corrected,
        }),
      );
      const openedCorrectionId = (
        await ctx.db.query("SELECT id FROM pilot_knowledge_corrections WHERE source_id=$1", [
          sourceId,
        ])
      ).rows[0].id;
      assert.deepEqual(
        await ctx.knowledge.resolveCorrection({
          correctionId: openedCorrectionId,
          disposition: "accepted",
          annotationId: correctedOutcome.annotationId,
        }),
        { disposition: "resolved", status: "accepted" },
      );
      const directAfterCorrection = await ctx.store.findSources([sourceId]);
      assert.equal(directAfterCorrection[0].content, unchanged.content);
      assert.equal((await ctx.knowledge.view("topic", "side")).entries.length, 1);

      const finalCommand = await addCommand(finalCommandId, "!knowledge topic trip");
      assert.equal(await answer(finalCommand), true);
      await ctx.restart();
      await deliver();
      assert.equal(sent.length, 2, "the final corrected topic command is delivered after restart");
      assert.match(sent[1].content, /does not establish a broader durable preference/);
      assert.match(sent[1].content, /discord\.com\/channels/);
      assert.equal((await ctx.knowledge.view("topic", "side")).entries.length, 1);
      assert.equal(
        (await ctx.db.query("SELECT learnable FROM pilot_sources WHERE id=$1", [commandId])).rows[0]
          .learnable,
        false,
        "polled knowledge commands never become learning evidence",
      );
    }),
);

test("R8: bounded rendering never leaves a displayed statement without its complete citation", () => {
  const entry = {
    ...candidate("x".repeat(800)),
    episodeKey: "trip",
    supersedes: null,
    sources: [{ sourceId, sourceRevision: 1, canonicalPermalink: source().url }],
  };
  const output = renderKnowledgeView({
    target: "topic",
    key: "trip",
    entries: [entry, entry, entry, entry],
  });
  const displayed = output.split("• ").length - 1;
  const completeCitations = output.split(`](${source().url})`).length - 1;
  assert.equal(completeCitations, displayed);
});

test("rendering exposes external reply boundaries and lack of clause-level evidence mapping", () => {
  const parentId = "555555555555555503";
  const output = renderKnowledgeView({
    target: "history",
    key: `${authorId}:trip`,
    entries: [
      {
        ...candidate("The speaker watched Twin Peaks for the first time."),
        episodeKey: "trip",
        supersedes: null,
        sources: [{ sourceId, sourceRevision: 1, canonicalPermalink: source().url }],
        replyBoundaries: [
          {
            childSourceId: sourceId,
            parentSourceId: parentId,
            status: "outside-selected-slice",
            dependencyRecorded: false,
            canonicalPermalink: `https://discord.com/channels/${guildId}/${channelId}/${parentId}`,
          },
        ],
      },
    ],
  });
  assert.match(output, /claim maps appear only when recorded/i);
  assert.match(output, /claim-level evidence map not recorded/);
  assert.match(output, /reply parent outside selected evidence/);
  assert.match(output, new RegExp(parentId));
});

test("R9: malformed history commands reject trailing arguments", () => {
  assert.throws(() =>
    parseKnowledgeCommand(`!knowledge history ${authorId} trip silently-ignored`),
  );
});

databaseTest(
  "R10: a deletion committed only to the pilot store cannot leave a renderable knowledge view",
  async ({ db, knowledge, prepare }) => {
    const store = await pilotStore(db, { guildId, channelId });
    await store.ingest(source());
    await knowledge.commitAnnotation(await prepare());
    // A crash after store.remove() but before knowledge.removeSource() is possible
    // because refreshSources() commits those changes separately.
    await store.remove(sourceId);
    const result = await retrieveCurrentKnowledgeView(
      knowledge,
      (ids) => refreshSources(store, {}, async () => {}, ids, undefined, knowledge),
      store.findSources,
      { target: "profile", memberId: authorId },
    );
    assert.equal(result.document.entries.length, 0);
  },
);

databaseTest(
  "R11: annotation admission rejects a source from a different manifest channel",
  async ({ knowledge }) => {
    const other = {
      ...manifest,
      id: "review-other-channel",
      episodes: [{ ...manifest.episodes[0], channelId: "222222222222222223" }],
    };
    await knowledge.installManifest(other);
    await assert.rejects(() =>
      knowledge.prepareAnnotation({
        manifestId: other.id,
        episodeKey: "trip",
        candidate: candidate(),
      }),
    );
  },
);

databaseTest(
  "R12: identical annotation admission creates only one prepared claim",
  async ({ db, prepare }) => {
    await prepare();
    await prepare();
    const result = await db.query(
      "SELECT count(*)::int AS count FROM pilot_knowledge_jobs WHERE status='prepared'",
    );
    assert.equal(result.rows[0].count, 1);
  },
);

databaseTest(
  "R13: a correction permits an explicit revision without quarantining its original source",
  async ({ db, knowledge, prepare }) => {
    const store = await pilotStore(db, { guildId, channelId });
    await store.ingest(source());
    await knowledge.commitAnnotation(await prepare());
    const opened = await knowledge.correct(correction);
    assert.deepEqual(
      (
        await db.query(
          "SELECT source_revision,reporter_id,affected_annotation_ids FROM pilot_knowledge_corrections WHERE id=$1",
          [opened.correctionId],
        )
      ).rows[0],
      {
        source_revision: 1,
        reporter_id: authorId,
        affected_annotation_ids: ["trip-preference"],
      },
    );
    assert.equal(
      (await knowledge.commitAnnotation(await prepare())).disposition,
      "applied",
      "a fresh source revalidation may reaffirm unchanged wording",
    );
    const revised = await prepare(
      candidate("The speaker prefers the train for this trip but may drive when service stops."),
    );
    assert.equal((await knowledge.commitAnnotation(revised)).disposition, "applied");
    assert.equal((await knowledge.view("profile", authorId)).entries.length, 1);
    assert.equal(
      (await knowledge.view("profile", authorId)).entries[0].interpretation,
      "The speaker prefers the train for this trip but may drive when service stops.",
    );
    const restarted = await communityKnowledge(db);
    assert.equal(
      (await restarted.view("profile", authorId)).entries[0].interpretation,
      "The speaker prefers the train for this trip but may drive when service stops.",
      "recovery must keep the explicit post-correction reading",
    );
    assert.deepEqual(
      (await store.findSources([sourceId])).map((item) => item.id),
      [sourceId],
      "the immutable source remains available as evidence for the revised reading",
    );
    assert.deepEqual(
      await restarted.resolveCorrection({
        correctionId: opened.correctionId,
        disposition: "accepted",
        annotationId: "trip-preference",
      }),
      { disposition: "resolved", status: "accepted" },
    );
    const retrieved = await retrieveCurrentKnowledgeView(
      restarted,
      async () => {},
      store.findSources,
      { target: "profile", memberId: authorId },
    );
    assert.deepEqual(
      retrieved.document.entries.map((entry) => entry.interpretation),
      ["The speaker prefers the train for this trip but may drive when service stops."],
      "a subsequent model knowledge read receives the explicit corrected interpretation",
    );
    assert.deepEqual(
      retrieved.sources.map((item) => item.id),
      [sourceId],
      "the corrected retrieval still carries its current original evidence packet",
    );
  },
);

databaseTest(
  "R14: a source edit fences an already prepared export before asynchronous rebuild",
  async ({ knowledge, prepare }) => {
    await knowledge.commitAnnotation(await prepare());
    const delayed = await knowledge.prepareExport({ target: "profile", key: authorId });
    await knowledge.registerSource(
      source(sourceId, "I prefer the train only while service is running."),
    );
    assert.deepEqual(await knowledge.commitExport(delayed), { disposition: "stale-view" });
  },
);

databaseTest(
  "R16: a correction requeues only its selected episode with durable non-evidence review context",
  async ({ db, knowledge, prepare }) => {
    const store = await pilotStore(db, { guildId, channelId });
    const reporter = source(
      commandId,
      `!knowledge correct https://discord.com/channels/${guildId}/${channelId}/${sourceId} The interpretation overstates this one trip.`,
    );
    await store.ingest(source());
    await store.ingest(reporter, false, false);
    await knowledge.registerSource(reporter);
    await knowledge.commitAnnotation(await prepare());
    await db.query(
      `INSERT INTO pilot_history_episodes(id,pass_id,manifest,status,read_ids)
       VALUES($1,$2,$3,'done',$4)`,
      [`${manifest.id}:trip`, manifest.id, manifest.episodes[0], [sourceId]],
    );
    const opened = await knowledge.correct({
      ...correction,
      reporterSourceId: commandId,
    });
    assert.deepEqual(opened.queuedEpisodeIds, [`${manifest.id}:trip`]);
    assert.equal(
      (
        await db.query("SELECT status FROM pilot_history_episodes WHERE id=$1", [
          `${manifest.id}:trip`,
        ])
      ).rows[0].status,
      "queued",
    );
    const expected = [
      {
        correctionId: opened.correctionId,
        sourceId,
        reporterSourceId: commandId,
      },
    ];
    assert.deepEqual(await knowledge.correctionReviewContexts(`${manifest.id}:trip`), expected);
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const database = (await db.query("SELECT current_database() AS database")).rows[0].database;
    const replacement = new pg.Client({ ...credentials, database });
    await replacement.connect();
    try {
      const restarted = await communityKnowledge(replacement);
      assert.deepEqual(
        await restarted.correctionReviewContexts(`${manifest.id}:trip`),
        expected,
        "restart retains the reporter source binding for the scoped re-evaluation",
      );
    } finally {
      await replacement.end();
    }
    await knowledge.registerSource(
      source(
        commandId,
        `!knowledge correct https://discord.com/channels/${guildId}/${channelId}/${sourceId} A changed reporter note.`,
      ),
    );
    await assert.rejects(
      () => knowledge.correctionReviewContexts(`${manifest.id}:trip`),
      (error) => error.code === "HISTORY_CORRECTION_CONTEXT_UNAVAILABLE",
      "an edited reporter message cannot become stale model review context",
    );
  },
);

databaseTest(
  "R17: a private operator correction and a same-guild cross-channel reporter requeue only the selected episode",
  async ({ db, knowledge, prepare }) => {
    const store = await pilotStore(db, { guildId, channelId: correctionChannelId });
    const reporter = {
      ...source(
        commandId,
        `!knowledge correct https://discord.com/channels/${guildId}/${channelId}/${sourceId} The interpretation needs a narrower reading.`,
      ),
      channelId: correctionChannelId,
      url: `https://discord.com/channels/${guildId}/${correctionChannelId}/${commandId}`,
    };
    await store.ingest(source());
    await store.ingest(reporter, false, false);
    await knowledge.registerSource(reporter);
    await knowledge.commitAnnotation(await prepare());
    await db.query(
      `INSERT INTO pilot_history_episodes(id,pass_id,manifest,status,read_ids)
       VALUES($1,$2,$3,'done',$4)`,
      [`${manifest.id}:trip`, manifest.id, manifest.episodes[0], [sourceId]],
    );
    const opened = await knowledge.correct({
      route: "correct",
      guildId,
      channelId,
      sourceId,
      reporterId: authorId,
      reporterSourceId: commandId,
      note: "The interpretation needs a narrower reading.",
    });
    assert.deepEqual(opened.queuedEpisodeIds, [`${manifest.id}:trip`]);
    assert.deepEqual(await knowledge.correctionReviewContexts(`${manifest.id}:trip`), [
      {
        correctionId: opened.correctionId,
        sourceId,
        reporterSourceId: commandId,
      },
    ]);
    await knowledge.resolveCorrection({
      correctionId: opened.correctionId,
      disposition: "rejected",
    });
    await knowledge.commitAnnotation(await prepare());
    const privateOpened = await knowledge.correct({
      route: "correct",
      guildId,
      channelId,
      sourceId,
      note: "Private operator review requests a narrower source-bound reading.",
      reviewOrigin: "private-operator",
    });
    assert.deepEqual(privateOpened.queuedEpisodeIds, [`${manifest.id}:trip`]);
    assert.deepEqual(await knowledge.correctionReviewContexts(`${manifest.id}:trip`), [
      {
        correctionId: privateOpened.correctionId,
        sourceId,
        reviewOrigin: "private-operator",
        reviewNote: "Private operator review requests a narrower source-bound reading.",
      },
    ]);
    const reviewedCandidate = candidate("The speaker prefers the train only for this trip.");
    const reviewedOutcome = await knowledge.commitAnnotation(await prepare(reviewedCandidate));
    assert.deepEqual(
      await knowledge.completePrivateOperatorReviews({
        manifestId: manifest.id,
        episodeKey: "trip",
        candidates: [reviewedCandidate],
        outcomes: [reviewedOutcome],
      }),
      [{ correctionId: privateOpened.correctionId, status: "accepted" }],
    );
    const sourceGeneration = (
      await db.query("SELECT correction_generation FROM pilot_knowledge_sources WHERE id=$1", [
        sourceId,
      ])
    ).rows[0].correction_generation;
    assert.deepEqual(
      await knowledge.correct({
        route: "correct",
        guildId,
        channelId,
        sourceId,
        note: "Private operator review requests a narrower source-bound reading.",
        reviewOrigin: "private-operator",
      }),
      { disposition: "already-resolved", status: "accepted", sourceId },
    );
    assert.equal(
      (
        await db.query("SELECT correction_generation FROM pilot_knowledge_sources WHERE id=$1", [
          sourceId,
        ])
      ).rows[0].correction_generation,
      sourceGeneration,
    );
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    const database = (await db.query("SELECT current_database() AS database")).rows[0].database;
    const replacement = new pg.Client({ ...credentials, database });
    await replacement.connect();
    try {
      const restarted = await communityKnowledge(replacement);
      assert.deepEqual(
        await restarted.correctionReviewContexts(`${manifest.id}:trip`),
        await knowledge.correctionReviewContexts(`${manifest.id}:trip`),
      );
    } finally {
      await replacement.end();
    }
  },
);

databaseTest(
  "R18: an unavailable older reporter is audited without blocking a newer bound correction",
  async ({ db, knowledge, prepare }) => {
    const store = await pilotStore(db, { guildId, channelId });
    const oldReporter = source(
      commandId,
      `!knowledge correct https://discord.com/channels/${guildId}/${channelId}/${sourceId} An older correction request.`,
    );
    const currentReporterId = "555555555555555598";
    const currentReporter = source(
      currentReporterId,
      `!knowledge correct https://discord.com/channels/${guildId}/${channelId}/${sourceId} A current narrower correction request.`,
    );
    await knowledge.commitAnnotation(await prepare());
    await db.query(
      `INSERT INTO pilot_history_episodes(id,pass_id,manifest,status,read_ids)
       VALUES($1,$2,$3,'done',$4)`,
      [`${manifest.id}:trip`, manifest.id, manifest.episodes[0], [sourceId]],
    );
    await store.ingest(oldReporter, false, true);
    await knowledge.registerSource(oldReporter);
    assert.deepEqual(await store.excludeCorrectionRequestEvidence([oldReporter.id]), [
      oldReporter.id,
    ]);
    assert.deepEqual(
      (
        await db.query("SELECT evidence_excluded,learnable FROM pilot_sources WHERE id=$1", [
          oldReporter.id,
        ])
      ).rows[0],
      { evidence_excluded: true, learnable: false },
    );
    const old = await knowledge.correct({
      ...correction,
      reporterSourceId: oldReporter.id,
      note: "An older correction request.",
    });
    await knowledge.removeSource(oldReporter.id);
    assert.deepEqual(await knowledge.correctionReviewContexts(`${manifest.id}:trip`), []);
    assert.deepEqual(
      (
        await db.query(
          "SELECT status,resolution_annotation_id FROM pilot_knowledge_corrections WHERE id=$1",
          [old.correctionId],
        )
      ).rows[0],
      { status: "unavailable", resolution_annotation_id: null },
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM pilot_knowledge_receipts WHERE kind='correction-unavailable' AND detail->>'correctionId'=$1",
          [old.correctionId],
        )
      ).rows[0].count,
      1,
    );
    await knowledge.registerSource(currentReporter);
    const current = await knowledge.correct({
      ...correction,
      reporterSourceId: currentReporter.id,
      note: "A current narrower correction request.",
    });
    const contexts = await knowledge.correctionReviewContexts(`${manifest.id}:trip`);
    assert.deepEqual(contexts, [
      { correctionId: current.correctionId, sourceId, reporterSourceId: currentReporter.id },
    ]);
    const reviewedCandidate = candidate("The train preference applies only to this trip.");
    const outcome = await knowledge.commitAnnotation(await prepare(reviewedCandidate));
    assert.deepEqual(
      await knowledge.completeCorrectionReviews({
        manifestId: manifest.id,
        episodeKey: "trip",
        candidates: [reviewedCandidate],
        outcomes: [outcome],
        correctionIds: contexts.map((item) => item.correctionId),
      }),
      [{ correctionId: current.correctionId, status: "accepted" }],
    );
  },
);
