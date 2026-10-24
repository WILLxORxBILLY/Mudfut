import pg from "pg";
import { readFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { state, assertPrivateState, safeError, saveJson } from "./runtime.mjs";
import { pilotStore, validateScope, deliver } from "./pilot-store.mjs";
import {
  discordTransport,
  refreshSources,
  syncKnowledgeSource,
  archiveTool,
  startTyping,
} from "./pilot-discord.mjs";
import { decodeUnderstanding } from "./pilot-memory.mjs";
import { postgresUnderstanding } from "./pilot-memory-postgres.mjs";
import { withLivePriority, livePriorityCheckpoint, progressPulse } from "./pilot-priority.mjs";
import { retryableFailure, boundedCleanup } from "./pilot-supervisor.mjs";
import { pilotModel, record } from "./pilot-model.mjs";
import { durableCandidate, isCorrectionRequest } from "./pilot-reply.mjs";
import { answerKnowledgeCommand } from "./pilot-knowledge-command.mjs";
import { pollLiveChannels, liveSource, liveChannelPlan } from "./pilot-live-channels.mjs";
import { timingTrace } from "./pilot-timing.mjs";
import { currentHistoryEpisode, historyQueue } from "./pilot-history.mjs";
import { operatorRequests } from "./pilot-requests.mjs";
import { historicalFailureClass } from "./pilot-history-failures.mjs";
import { archiveReader, ArchiveUnavailable, optionalArchive } from "./pilot-archive-reader.mjs";
import { channelPollStatus, channelStatus } from "./pilot-channel-status.mjs";
import { archiveDiscussions } from "./pilot-discussions.mjs";
import {
  archiveAuthorityDigest,
  communityKnowledge,
  retrieveCurrentKnowledgeView,
  validateArchiveManifest,
} from "./community-knowledge.mjs";
import { reconcilePendingHistoryDerivations } from "./community-knowledge-recovery.mjs";

process.umask(0o077);
assertPrivateState(state);
if (process.env.MUDFUT_AUTH_MODE !== "letta")
  throw new Error("Use MUDFUT_AUTH_MODE=letta for renewable subscription operation");
const mode = process.argv[2] ?? "run";
if (!["run", "once", "status", "recall-proof"].includes(mode))
  throw new Error("Use run, once, status or recall-proof");
async function privateFile(name) {
  const path = join(state, name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error(`${name} must be a private regular file (chmod 600)`);
  return readFile(path, "utf8");
}
async function optionalJson(name) {
  try {
    return JSON.parse(await privateFile(name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}
const config = validateScope(JSON.parse(await privateFile("pilot.json")));
const connection = JSON.parse(await privateFile("postgres.json"));
if (
  connection.host !== "127.0.0.1" ||
  connection.database !== "mudfut_pilot" ||
  connection.user !== "mudfut_pilot"
)
  throw new Error("Pilot requires the dedicated loopback database/role mudfut_pilot");
const db = new pg.Client({
  ...connection,
  statement_timeout: 10000,
  connectionTimeoutMillis: 10000,
});
const memoryDb = new pg.Client({
  ...connection,
  statement_timeout: 10000,
  connectionTimeoutMillis: 10000,
});
let history,
  model,
  knowledge,
  knowledgeManifest,
  stopping = false,
  connectionFailure,
  timing,
  phase = "startup";
const stop = () => {
  stopping = true;
  void model?.abort().catch(() => {});
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
// A killed supervisor closes IPC; finish/abort safely instead of leaving an orphan.
if (process.send) process.once("disconnect", stop);
const lostConnection = (error) => {
  connectionFailure = error;
  stop();
};
db.on("error", lostConnection);
memoryDb.on("error", lostConnection);
try {
  await db.connect();
  if (mode === "status") {
    console.log(
      JSON.stringify(
        await channelStatus(db, config, {
          poll: await optionalJson("channel-polls.json"),
          health: await optionalJson("pilot-health.json"),
          recovery: await optionalJson("pilot-recovery.json"),
          archive: (await optionalJson("history-postgres.json"))
            ? await optionalJson("archive-status.json")
            : { state: "not-configured" },
        }),
        null,
        2,
      ),
    );
  } else {
    const discord = discordTransport((await privateFile("discord-token")).trim(), record);
    const bot = await discord.me();
    const channelPlan = await liveChannelPlan(discord, config);
    const polls = channelPollStatus(config, channelPlan.routes, {
      initial: await optionalJson("channel-polls.json"),
      save: (snapshot) => saveJson(join(state, "channel-polls.json"), snapshot),
    });
    let liveConfig = config;
    const store = await pilotStore(db, config);
    knowledge = await communityKnowledge(db);
    try {
      knowledgeManifest = validateArchiveManifest(
        JSON.parse(await privateFile("community-knowledge-manifest.json")),
      );
      const installed = await knowledge.installManifest(knowledgeManifest);
      const resumed = await knowledge.resumePrepared();
      await record({
        type: "community_knowledge_manifest",
        manifestId: installed.id,
        generation: installed.generation,
        disposition: installed.disposition,
        resumed: resumed.map((item) => item.disposition),
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const pulse = progressPulse((receipt) =>
      saveJson(join(state, "pilot-health.json"), { pid: process.pid, ...receipt }),
    );
    await pulse("startup_database_ready");
    if (store.reclassified.length)
      await record({ type: "reply_classification_upgrade", sourceIds: store.reclassified });
    let historyCredentials;
    try {
      historyCredentials = JSON.parse(await privateFile("history-postgres.json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (historyCredentials) {
      const credentials = historyCredentials;
      if (credentials.host !== "127.0.0.1" || credentials.user !== "mudfut_history_reader")
        throw new Error("History requires the separate local read-only role");
      history = archiveReader(
        new pg.Client({
          ...credentials,
          options: "-c default_transaction_read_only=on",
          statement_timeout: 10000,
          connectionTimeoutMillis: 10000,
        }),
        {
          report: async (status) => {
            await saveJson(join(state, "archive-status.json"), status);
            if (status.state === "paused") await record({ type: "archive_paused", ...status });
          },
        },
      );
      await optionalArchive(() => history.connect());
    }
    await memoryDb.connect();
    let activeCheckpoint;
    let readKnowledgeView = async () => {
      throw new Error("Community knowledge views are not ready");
    };
    model = await pilotModel(archiveTool(store, discord, { ...config, botId: bot.id }, history), {
      memoryOnly: mode === "recall-proof",
      botId: bot.id,
      discussions: history
        ? archiveDiscussions(store, discord, { ...config, botId: bot.id }, history, {
            checkpoint: async () => activeCheckpoint?.(),
          })
        : undefined,
      sourceLookup: store.findSources,
      validateSources: (ids) =>
        refreshSources(store, discord, record, ids, activeCheckpoint, knowledge),
      knowledgeViews: (query) => readKnowledgeView(query),
      memoryFactory: (legacy, { agentId }) =>
        postgresUnderstanding(memoryDb, legacy, { agentId, record }),
    });
    const correctionRequestIds = (await store.sources())
      .filter((row) => isCorrectionRequest(row.source))
      .map((row) => row.id);
    const excludedCorrectionEvidence = correctionRequestIds.length
      ? await store.excludeCorrectionRequestEvidence(correctionRequestIds)
      : [];
    if (excludedCorrectionEvidence.length) {
      if (!(await store.reset(model.memory)))
        throw new Error("Correction-request memory invalidation was not scheduled");
      await record({
        type: "correction_request_evidence_excluded",
        sourceIds: excludedCorrectionEvidence,
      });
    }
    const requests = await operatorRequests(store, state, record);
    const bufferedIncoming = new Map();
    const pollFresh = async () => {
      let discovered;
      try {
        discovered = { ...(await channelPlan.discover()), at: new Date().toISOString() };
      } catch (error) {
        await polls.discoveryFailed(error);
        throw error;
      }
      await store.registerThreads(discovered.threads, channelPlan.forumIds);
      liveConfig = { ...config, liveChannelIds: discovered.channelIds };
      const messages = await pollLiveChannels(
        store,
        discord,
        config,
        discovered.channelIds,
        (results) => polls.polled(discovered, results),
      );
      await pulse("live_poll_complete");
      return messages;
    };
    const isUrgent = async (messages) => {
      for (const message of messages)
        if (
          !message.author.bot &&
          [0, 19].includes(message.type) &&
          (await store.isAddressed(liveSource(message, liveConfig), bot.id, discord.get))
        )
          return true;
      return false;
    };
    const checkpoint = livePriorityCheckpoint({ poll: pollFresh, isUrgent });
    const learning = historyQueue(store, discord, config, state, record, history, {
      shouldYield: async () => {
        await checkpoint();
        return false;
      },
    });
    readKnowledgeView = (query) =>
      retrieveCurrentKnowledgeView(
        knowledge,
        (ids) => refreshSources(store, discord, record, ids, activeCheckpoint, knowledge),
        store.findSources,
        query,
      );
    const historyBindingFor = async (batch) => {
      if (!knowledgeManifest || !historyCredentials || !batch?.historyEpisode) return null;
      const episode = knowledgeManifest.episodes.find(
        (item) => `${knowledgeManifest.id}:${item.key}` === batch.historyEpisode,
      );
      if (!episode) return null;
      const directSources = (batch.rows ?? []).map((row) => row.source);
      const contextSources = batch.context?.surroundingMessages ?? [];
      if (
        JSON.stringify(directSources.map((source) => source.id)) !==
          JSON.stringify(episode.sourceIds) ||
        contextSources.length !== episode.contextIds.length ||
        episode.contextIds.some((id) => !contextSources.some((source) => source.id === id))
      )
        throw new Error("Historical projection selection differs from the installed manifest");
      return knowledge.bindHistoryProjection({
        manifestId: knowledgeManifest.id,
        episodeKey: episode.key,
        historyEpisodeId: batch.historyEpisode,
        directSources,
        contextSources,
        archiveAuthority: archiveAuthorityDigest(
          knowledgeManifest.archiveConnectionId,
          historyCredentials,
        ),
        correctionIds: (batch.context?.correctionRequests ?? []).map(
          (request) => request.correctionId,
        ),
      });
    };
    const recoverHistoryDerivation = async () => {
      if (!history || !historyCredentials) return { disposition: "idle" };
      const shouldYield = async () => {
        await checkpoint();
        return false;
      };
      const outcome = await optionalArchive(() =>
        reconcilePendingHistoryDerivations(knowledge, {
          loadEpisode: (episode, shouldYield) =>
            currentHistoryEpisode(discord, history, episode, shouldYield),
          archiveAuthority: async (manifest) =>
            archiveAuthorityDigest(manifest.archiveConnectionId, historyCredentials),
          shouldYield,
        }),
      );
      if (outcome.disposition === "recorded")
        await record({
          type: "community_history_derivation",
          manifestId: outcome.manifestId,
          episodeId: outcome.episodeId,
          status: outcome.status,
          projectedCount: outcome.projectedCount ?? 0,
        });
      return outcome;
    };
    const attachCorrectionReviewContext = async (batch) => {
      if (!batch?.historyEpisode) return batch;
      const requests = await knowledge.correctionReviewContexts(batch.historyEpisode);
      if (!requests.length) return batch;
      const reporterSourceIds = requests.map((request) => request.reporterSourceId).filter(Boolean);
      if (reporterSourceIds.length)
        await refreshSources(store, discord, record, reporterSourceIds, undefined, knowledge);
      const currentRequests = await knowledge.correctionReviewContexts(batch.historyEpisode);
      if (
        currentRequests.length !== requests.length ||
        currentRequests.some(
          (request, index) => request.correctionId !== requests[index].correctionId,
        )
      ) {
        const error = new Error("A correction review request changed during source revalidation");
        error.code = "HISTORY_CORRECTION_CONTEXT_UNAVAILABLE";
        throw error;
      }
      const currentReporterIds = currentRequests
        .map((request) => request.reporterSourceId)
        .filter(Boolean);
      const sources = new Map(
        (await store.findSources(currentReporterIds)).map((source) => [source.id, source]),
      );
      if (sources.size !== currentReporterIds.length) {
        const error = new Error(
          "A correction review request is no longer available for its bounded episode",
        );
        error.code = "HISTORY_CORRECTION_CONTEXT_UNAVAILABLE";
        throw error;
      }
      batch.context = {
        ...batch.context,
        correctionRequests: currentRequests.map((request) => ({
          ...request,
          ...(request.reporterSourceId
            ? { reporterSource: sources.get(request.reporterSourceId) }
            : {}),
        })),
      };
      return batch;
    };
    if (!decodeUnderstanding((await model.memory.read()).content))
      throw new Error("Invalid structured understanding; restore or inspect private state");
    console.log(
      `Pilot active: guild ${config.guildId}, channel ${config.channelId}, bot ${bot.id}. Ctrl-C stops it.`,
    );
    await saveJson(join(state, "pilot-process.json"), {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    await record({ type: "scope", config, botId: bot.id });
    await pulse("startup_ready");
    do {
      timing = timingTrace({ scope: "cycle" });
      let incoming = [],
        batch,
        preempted = false;
      try {
        phase = "poll";
        incoming = await timing.measure("poll", pollFresh);
        const meta = await store.meta();
        incoming = [
          ...new Map(
            [...bufferedIncoming.values(), ...incoming].map((message) => [message.id, message]),
          ).values(),
        ]
          .filter(
            (message) =>
              !meta.cursors[message.channel_id] ||
              BigInt(message.id) > BigInt(meta.cursors[message.channel_id]),
          )
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        bufferedIncoming.clear();
        timing.event.detected = incoming
          .filter((message) => !message.author.bot && [0, 19].includes(message.type))
          .map((message) => ({ sourceId: message.id, createdAt: message.timestamp }));
        for (const message of incoming) {
          if (!message.author.bot && [0, 19].includes(message.type)) {
            const source = liveSource(message, liveConfig);
            // Initial catch-up is quiet; later mentions/replies use durable outbox uniqueness.
            const knowledgeCommand = source.content.trimStart().startsWith("!knowledge");
            const addressed =
              !knowledgeCommand &&
              Boolean(meta.cursors[source.channelId]) &&
              (await store.isAddressed(source, bot.id, discord.get));
            await store.ingest(source, addressed, !knowledgeCommand);
            await syncKnowledgeSource(knowledge, source);
            const commandHandled =
              knowledgeCommand && Boolean(meta.cursors[source.channelId])
                ? await answerKnowledgeCommand({
                    source,
                    config,
                    knowledge,
                    discord,
                    store,
                    readKnowledgeView,
                    record,
                  })
                : false;
            await record({ type: "discord_source", source, addressed, commandHandled });
          }
          await store.cursor(message.id, message.channel_id);
        }
        for (const channelId of liveConfig.liveChannelIds) {
          if (!meta.cursors[channelId] && !incoming.some((m) => m.channel_id === channelId))
            // Zero is a lower bound, avoiding a local-clock cutoff that could skip messages.
            await store.cursor("00000000000000000", channelId);
        }
        phase = "reconcile";
        // Detect and persist live work first; cold validation must not stand in front of a direct reply.
        const readyDelivery = (
          await db.query("SELECT 1 FROM pilot_outbox WHERE status IN ('ready','sending') LIMIT 1")
        ).rowCount;
        if (!readyDelivery && !(await store.next())?.replyTo && !(await requests.next()))
          await timing.measure("background_validation", () =>
            refreshSources(store, discord, record, undefined, checkpoint, knowledge),
          );
        await timing.measure("memory_reconcile", async () => {
          const pending = (
            await db.query("SELECT validation_ids FROM pilot_work WHERE status='prepared'")
          ).rows;
          const pendingIds = [...new Set(pending.flatMap((r) => r.validation_ids))];
          if (pendingIds.length)
            await refreshSources(store, discord, record, pendingIds, undefined, knowledge);
          if (await store.reset(model.memory))
            await record({ type: "memory_invalidated", epoch: (await store.meta()).epoch });
          await store.finish(model.memory, { onHistoricalFailure: learning.deferCandidate });
          await recoverHistoryDerivation();
          await requests.reconcile();
          await pulse("memory_reconcile_complete");
        });
        // Complete previously committed delivery before admitting another quiet model turn.
        const readyEvidence = (
          await db.query(`SELECT w.validation_ids FROM pilot_work w
        JOIN pilot_outbox o ON o.source_id=w.reply_to WHERE o.status='ready' AND w.status='done'`)
        ).rows;
        const readyIds = [...new Set(readyEvidence.flatMap((work) => work.validation_ids))];
        if (readyIds.length) {
          await refreshSources(store, discord, record, readyIds, undefined, knowledge);
          if (await store.reset(model.memory))
            await record({ type: "memory_invalidated", epoch: (await store.meta()).epoch });
        }
        phase = "delivery";
        if (!stopping)
          await timing.measure("delivery_recovery", () =>
            deliver(store, discord, bot.id, config.channelId, record),
          );
        // Quiet work shares the same source validation, worker and revisioned memory authority.
        batch = await store.next();
        if (!batch?.replyTo) batch = (await requests.next()) ?? batch;
        timing.event.operatorRequestId = batch?.operatorRequest?.id ?? null;
        if (!batch && mode !== "recall-proof" && !history?.paused) {
          phase = "history_load";
          batch = await timing.measure("history_load", () => learning.next());
          batch = await timing.measure("correction_review_context", () =>
            attachCorrectionReviewContext(batch),
          );
        }
        timing.event.historyEpisode = batch?.historyEpisode ?? null;
        if (batch?.historyEpisode && (await store.reset(model.memory)))
          await record({ type: "memory_invalidated", epoch: (await store.meta()).epoch });
        timing.event.replyTo = batch?.replyTo ?? null;
        timing.event.sourceIds = batch?.rows.map((row) => row.id) ?? [];
        const stopTyping =
          batch?.replyTo && !stopping
            ? startTyping(discord, batch.rows[0].source.channelId, record)
            : () => {};
        try {
          if (batch && !stopping) {
            if (batch.replyTo && mode !== "recall-proof")
              batch.context = await timing.measure("context_load", () =>
                store.context(batch.replyTo),
              );
            const epoch = (await store.meta()).epoch;
            phase = "model";
            const generate = async (check) => {
              activeCheckpoint = check;
              try {
                const result = await timing.measure("model_turn", () => model.turn(batch, epoch));
                phase = batch.historyEpisode
                  ? "history_validation"
                  : batch.operatorRequest
                    ? "operator_validation"
                    : "commit";
                await timing.measure("final_validation", () =>
                  refreshSources(store, discord, record, result.usedSourceIds, check, knowledge),
                );
                if (check) await check();
                return result;
              } finally {
                activeCheckpoint = undefined;
              }
            };
            const result = !batch.replyTo
              ? await withLivePriority(generate, {
                  poll: pollFresh,
                  isUrgent,
                  abort: () => model.abort(),
                  record,
                })
              : await generate();
            if ((await store.meta()).epoch !== epoch) {
              await record({ type: "stale_generation_discarded", epoch });
              if (await store.reset(model.memory))
                await record({ type: "memory_invalidated", epoch: (await store.meta()).epoch });
            } else {
              let committed = false;
              await timing.measure("memory_commit", async () => {
                phase = "prepare";
                const historyProjection = await historyBindingFor(batch);
                const workId = await store.prepare(
                  epoch,
                  batch,
                  durableCandidate(batch, result),
                  result.reply,
                  result.usedSourceIds,
                  historyProjection,
                );
                phase = "memory_commit";
                const finished = await store.finish(model.memory, {
                  onHistoricalFailure: learning.deferCandidate,
                });
                committed = finished.completed.includes(workId);
                await requests.reconcile();
                phase = committed ? "memory_committed" : "history_deferred";
                await pulse("memory_commit_complete");
              });
              if (committed)
                await record({
                  type: "memory_committed",
                  epoch,
                  memory: await model.memory.read(),
                  sources: batch.rows.map((r) => r.id),
                  decisions: result.candidate.audit,
                  historyEpisode: batch.historyEpisode ?? null,
                  operatorRequestId: batch.operatorRequest?.id ?? null,
                });
              if (committed) await recoverHistoryDerivation();
            }
          }
          phase = "delivery";
          if (!stopping)
            await timing.measure("delivery", () =>
              deliver(store, discord, bot.id, config.channelId, record),
            );
        } finally {
          stopTyping();
        }
      } catch (error) {
        if (error.code === "HISTORY_PREEMPTED") {
          for (const message of error.messages) bufferedIncoming.set(message.id, message);
          preempted = true;
          await record({
            type: "history_yielded",
            historyEpisode: batch?.historyEpisode ?? null,
            incomingIds: error.messages.map((message) => message.id),
            queuedUnread: Boolean(batch?.historyEpisode),
          });
        } else if (
          error instanceof ArchiveUnavailable &&
          phase === "history_load" &&
          !stopping &&
          !connectionFailure
        ) {
          // No prepared candidate or native transaction is bypassed here.
          // The archive reader records its pause; queued selections remain unread.
          await pulse("archive_paused_live_continues");
        } else if (
          batch?.operatorRequest &&
          !stopping &&
          !connectionFailure &&
          ["model", "operator_validation"].includes(phase) &&
          ["episode", "source_access"].includes(historicalFailureClass(error, { phase })) &&
          (await requests.fail(batch.operatorRequest.id, error))
        ) {
          await record({
            type: "operator_generation_failed",
            requestId: batch.operatorRequest.id,
            error: safeError(error),
          });
          await pulse("operator_failure_recorded");
        } else {
          const episodeId =
            batch?.historyEpisode ?? (phase === "history_load" ? learning.activeEpisode : null);
          // Once preparation starts, durable candidate recovery owns the work; never rerun its model.
          const retry =
            episodeId &&
            !stopping &&
            !connectionFailure &&
            ["history_load", "model", "history_validation"].includes(phase)
              ? await learning.failEpisode(episodeId, error, { phase })
              : null;
          if (!retry) throw error;
          timing.event.historyEpisode = episodeId;
          await pulse("history_failure_recorded");
        }
      }
      // Keep idle polling out of the audit; retain every active cycle's spans.
      if (batch || incoming.length || preempted) await record(timing.event);
      timing = undefined;
      if (connectionFailure) throw connectionFailure;
      await pulse("cycle_complete");
      if (mode === "once" || stopping || (mode === "recall-proof" && batch?.replyTo)) break;
      if (!preempted) await delay(5000);
    } while (!stopping);
  }
} catch (error) {
  if (timing) await record(timing.event);
  const failure = connectionFailure ?? error;
  const retryable = retryableFailure({
    message: safeError(failure),
    status: failure.status,
    code: failure.code,
    cause: failure.cause,
    retryable: phase === "model",
  });
  await record({ type: "failure", phase, retryable, error: safeError(failure) });
  console.error(safeError(failure));
  process.exitCode = stopping && !connectionFailure ? 0 : retryable ? 75 : 78;
} finally {
  const cleanup = await boundedCleanup([
    model?.close(),
    history?.end(),
    memoryDb.end(),
    db.end(),
  ]).catch((error) => {
    console.error(safeError(error));
    // The supervisor reaps the worker process group, including a stuck SDK child.
    process.exit(process.exitCode || 75);
  });
  for (const result of cleanup)
    if (result.status === "rejected") {
      console.error(safeError(result.reason));
      process.exitCode ||= 75;
    }
  if (model) await rm(join(state, "pilot-process.json"), { force: true });
  // An IPC disconnect listener keeps Node alive even after all clients close.
  if (process.connected) process.disconnect();
}
