// Private historical replay with real model calls. Never connects a Discord sender.
// episode.json contains config, sources, probes, correction and correctedProbe;
// expected answers may be stored there for review but are never sent to the model.
import pg from "pg";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { state, assertPrivateState, safeError } from "./runtime.mjs";
import { pilotStore, sourceRecord, validateScope, snowflake } from "./pilot-store.mjs";
import { pilotModel, record } from "./pilot-model.mjs";
import { decodeUnderstanding } from "./pilot-memory.mjs";
import { evaluationMemory } from "./pilot-evaluation-memory.mjs";
import { durableCandidate } from "./pilot-reply.mjs";

process.umask(0o077);
assertPrivateState(state);
const episode = JSON.parse(await readFile(join(state, "episode.json"), "utf8"));
const connection = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
if (connection.host !== "127.0.0.1" || !/^mudfut_eval_[a-z0-9_]+$/.test(connection.database))
  throw new Error("Evaluation requires a separate loopback mudfut_eval_* database");
const phase = process.argv[2];
if (!["learn", "correction", "corrected"].includes(phase) && !/^probe:[0-9]+$/.test(phase ?? ""))
  throw new Error("Use learn, probe:N, correction or corrected; each runs in a fresh process");
const config = validateScope(episode.config);
if (episode.botId !== undefined && !snowflake(episode.botId))
  throw new Error("Invalid evaluation bot ID");
const db = new pg.Client(connection);
const memoryDb = new pg.Client(connection);
let model;
try {
  await db.connect();
  await memoryDb.connect();
  const store = await pilotStore(db, config);
  if (phase === "learn" && (await db.query("SELECT 1 FROM pilot_sources LIMIT 1")).rowCount)
    throw new Error(
      "First-pass evaluation already exists; use fresh isolated state and preserve this run",
    );
  model = await pilotModel(
    async () => {
      throw new Error("Archive search disabled for memory evaluation");
    },
    {
      memoryOnly: true,
      sourceLookup: store.findSources,
      botId: episode.botId ?? "444444444444444444",
      memoryFactory: (legacy, { agentId }) =>
        evaluationMemory(memoryDb, legacy, { agentId, record }),
    },
  );
  const initial = await model.memory.read();
  if (!decodeUnderstanding(initial.content)) throw new Error("Unexpected evaluation memory format");
  await record({
    type: "evaluation_phase",
    phase,
    label: episode.label,
    memoryStorage: "PostgreSQL",
    archiveSearch: false,
    discordValidation: false,
    publicDelivery: false,
  });
  const turn = async (batch) => {
    const epoch = (await store.meta()).epoch;
    const result = await model.turn(batch, epoch);
    await store.prepare(epoch, batch, durableCandidate(batch, result), result.reply);
    await store.finish(model.memory);
    await record({
      type: "evaluation_result",
      phase,
      reply: result.reply,
      decisions: result.candidate.audit,
      replyEvidence: result.replyEvidence,
      memory: await model.memory.read(),
    });
    console.log(
      JSON.stringify({
        phase,
        reply: result.reply,
        entries: decodeUnderstanding((await model.memory.read()).content).length,
      }),
    );
  };
  if (phase === "learn") {
    if (!Array.isArray(episode.sources) || episode.sources.length > 100)
      throw new Error("Replay is limited to 100 source messages");
    for (const source of episode.sources) {
      const normalized = sourceRecord(
        {
          id: source.id,
          type: source.replyTo ? 19 : 0,
          channel_id: source.channelId,
          content: source.content,
          author: { id: source.authorId, username: source.authorName },
          timestamp: source.createdAt,
          edited_timestamp: source.editedAt,
          message_reference: source.replyTo ? { message_id: source.replyTo } : undefined,
        },
        source.guildId,
        source.channelId,
      );
      await store.ingest(normalized);
    }
    for (let batch; (batch = await store.next());) await turn(batch);
  } else {
    const selected =
      phase === "correction"
        ? episode.correction
        : phase === "corrected"
          ? episode.correctedProbe
          : episode.probes[Number(phase.slice(6))];
    if (!selected) throw new Error("Missing evaluation probe");
    const source = sourceRecord(
      {
        id: selected.id,
        channel_id: config.channelId,
        content: selected.content,
        author: { id: selected.authorId, username: selected.authorName },
        timestamp: new Date().toISOString(),
      },
      config.guildId,
      config.channelId,
    );
    await store.ingest(source, true);
    await turn({ rows: [{ id: source.id, source }], replyTo: source.id });
  }
} catch (error) {
  await record({ type: "evaluation_failure", phase, error: safeError(error) });
  throw error;
} finally {
  try {
    await model?.close();
  } finally {
    await Promise.all([memoryDb.end(), db.end()]);
  }
}
