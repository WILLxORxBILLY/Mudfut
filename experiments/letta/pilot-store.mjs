import {
  generationFailureSchema,
  generationReady,
  generationAttempts,
} from "./pilot-generation-failures.mjs";
import { createHash, randomUUID } from "node:crypto";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
const stableJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
};
export const canonicalDigest = (value) => digest(stableJson(value));
export function normalizedSource(source) {
  return {
    id: source.id,
    guildId: source.guildId,
    channelId: source.channelId,
    authorId: source.authorId,
    authorName: typeof source.authorName === "string" ? source.authorName.slice(0, 160) : null,
    content: source.content,
    createdAt: source.createdAt,
    editedAt: source.editedAt ?? null,
    replyTo: source.replyTo ?? null,
    url: source.url,
  };
}
export const sourceFingerprint = (source) => digest(JSON.stringify(normalizedSource(source)));
export const emptyMemory =
  "---\nname: community\ndescription: Revisable community understanding with source provenance\n---\nNo current understanding. Learn only from eligible source messages.\n";
export const snowflake = (s) => typeof s === "string" && /^[0-9]{17,20}$/.test(s);
export const hasTextEvidence = (source) =>
  typeof source?.content === "string" && source.content.trim().length > 0;

export const replyChannels = (config) =>
  config.replyChannelIds === undefined ? [config.channelId] : config.replyChannelIds;

export function validateScope(config) {
  if (!config || !snowflake(config.guildId) || !snowflake(config.channelId))
    throw new Error("Invalid pilot guild/channel scope");
  const channels = replyChannels(config);
  if (
    !Array.isArray(channels) ||
    !channels.length ||
    channels.some((id) => !snowflake(id)) ||
    new Set(channels).size !== channels.length ||
    !channels.includes(config.channelId)
  )
    throw new Error("Invalid pilot reply channels; include the primary channel exactly once");
  return { ...config, historyScope: config.historyScope ?? [] };
}

// A forward/crosspost reference is not a reply edge. Missing reference scope
// inherits the validated REST endpoint; explicit scope must match it.
export function discordReplyTo(message, guildId, channelId) {
  const reference = message?.message_reference;
  const validId = (id) =>
    typeof id === "string" && /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= 18446744073709551615n;
  if (
    message?.type !== 19 ||
    (reference?.type ?? 0) !== 0 ||
    !validId(message.id) ||
    !validId(reference?.message_id) ||
    reference.message_id === message.id ||
    !validId(guildId) ||
    !validId(channelId) ||
    message.channel_id !== channelId ||
    (message.guild_id !== undefined && message.guild_id !== guildId) ||
    (reference.channel_id !== undefined && reference.channel_id !== channelId) ||
    (reference.guild_id !== undefined && reference.guild_id !== guildId)
  )
    return null;
  return reference.message_id;
}

export function sourceRecord(message, guildId, channelId) {
  if (
    !snowflake(message.id) ||
    message.channel_id !== channelId ||
    (message.guild_id !== undefined && message.guild_id !== guildId) ||
    !snowflake(message.author?.id) ||
    typeof message.content !== "string" ||
    message.content.length > 16000 ||
    !Number.isFinite(Date.parse(message.timestamp))
  )
    throw new Error("Invalid Discord source message");
  return {
    id: message.id,
    guildId,
    channelId,
    authorId: message.author.id,
    authorName: message.member?.nick ?? message.author.global_name ?? message.author.username,
    content: message.content,
    createdAt: message.timestamp,
    editedAt: message.edited_timestamp ?? null,
    replyTo: discordReplyTo(message, guildId, channelId),
    url: `https://discord.com/channels/${guildId}/${channelId}/${message.id}`,
  };
}

// ponytail: channels share one serial memory writer and delivery queue. Throughput
// is bounded by one model turn; add coordinated per-agent queues before adding writers.
export async function pilotStore(db, config) {
  validateScope(config);
  const lock = await db.query("SELECT pg_try_advisory_lock(1560387, 1127029) AS acquired");
  if (!lock.rows[0].acquired) throw new Error("Another pilot worker owns this database");
  await db.query(`
    CREATE TABLE IF NOT EXISTS pilot_meta (
      id boolean PRIMARY KEY DEFAULT true CHECK(id), scope jsonb NOT NULL,
      cursor text, epoch integer NOT NULL DEFAULT 0, rebuild boolean NOT NULL DEFAULT false,
      relearning boolean NOT NULL DEFAULT false);
    CREATE TABLE IF NOT EXISTS pilot_sources (
      id text PRIMARY KEY, source jsonb NOT NULL, hash text NOT NULL,
      deleted boolean NOT NULL DEFAULT false, learned boolean NOT NULL DEFAULT false,
      addressed boolean NOT NULL DEFAULT false);
    CREATE TABLE IF NOT EXISTS pilot_live_threads (
      channel_id text PRIMARY KEY, parent_id text NOT NULL, guild_id text NOT NULL);
    CREATE TABLE IF NOT EXISTS pilot_optouts (author_id text PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS pilot_source_holds (
      source_id text PRIMARY KEY, reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS pilot_work (
      id text PRIMARY KEY, epoch integer NOT NULL, source_ids text[] NOT NULL,
      candidate jsonb NOT NULL, reply_to text, reply text,
      status text NOT NULL DEFAULT 'prepared', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS pilot_outbox (
      source_id text PRIMARY KEY, content text NOT NULL, epoch integer NOT NULL,
      status text NOT NULL DEFAULT 'ready', discord_id text,
      attempted_at timestamptz, error text, receipt jsonb);
    ALTER TABLE pilot_meta ADD COLUMN IF NOT EXISTS cursors jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE pilot_meta ADD COLUMN IF NOT EXISTS invalid_sources text[] NOT NULL DEFAULT '{}';
    ALTER TABLE pilot_meta ADD COLUMN IF NOT EXISTS memory_version integer NOT NULL DEFAULT 1;
    ALTER TABLE pilot_sources ADD COLUMN IF NOT EXISTS learnable boolean NOT NULL DEFAULT true;
    ALTER TABLE pilot_sources ADD COLUMN IF NOT EXISTS evidence_excluded boolean NOT NULL DEFAULT false;
    ALTER TABLE pilot_sources ADD COLUMN IF NOT EXISTS checked_at timestamptz;
    ALTER TABLE pilot_work ADD COLUMN IF NOT EXISTS history_episode text;
    ALTER TABLE pilot_work ADD COLUMN IF NOT EXISTS validation_ids text[] NOT NULL DEFAULT '{}';
    ALTER TABLE pilot_work ADD COLUMN IF NOT EXISTS history_projection jsonb;
    ALTER TABLE pilot_outbox ADD COLUMN IF NOT EXISTS receipt jsonb;
    CREATE TABLE IF NOT EXISTS pilot_history_passes (
      id text PRIMARY KEY, manifest jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS pilot_history_episodes (
      id text PRIMARY KEY, pass_id text NOT NULL, manifest jsonb NOT NULL,
      status text NOT NULL DEFAULT 'queued', work_id text,
      read_ids text[] NOT NULL DEFAULT '{}', context_ids text[] NOT NULL DEFAULT '{}',
      excluded jsonb NOT NULL DEFAULT '[]', completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS pilot_sources_pending ON pilot_sources ((id::numeric)) WHERE NOT deleted AND NOT learned AND learnable;
    CREATE INDEX IF NOT EXISTS pilot_sources_revalidation ON pilot_sources (checked_at NULLS FIRST) WHERE NOT deleted;
  `);
  // A correction hold must survive source cleanup long enough to remain auditable.
  await db.query(
    "ALTER TABLE pilot_source_holds DROP CONSTRAINT IF EXISTS pilot_source_holds_source_id_fkey",
  );
  const { historyFailureSchema } = await import("./pilot-history-failures.mjs");
  await db.query(historyFailureSchema);
  await db.query(generationFailureSchema);
  await db.query("INSERT INTO pilot_meta(id,scope) VALUES(true,$1) ON CONFLICT DO NOTHING", [
    config,
  ]);
  const saved = (await db.query("SELECT scope FROM pilot_meta")).rows[0].scope;
  if (
    saved.guildId !== config.guildId ||
    saved.channelId !== config.channelId ||
    replyChannels(saved).some((id) => !replyChannels(config).includes(id))
  )
    throw new Error(
      "Pilot live channel differs from persisted configuration; use a separate state/database",
    );
  await db.query(
    `UPDATE pilot_sources SET learnable=false,learned=true WHERE source->>'guildId'<>$1 OR
      NOT (source->>'channelId'=ANY($2::text[]) OR EXISTS(SELECT 1 FROM pilot_live_threads t
        WHERE t.channel_id=source->>'channelId' AND t.guild_id=$1 AND t.parent_id=ANY($2::text[])))`,
    [config.guildId, replyChannels(config)],
  );
  // Preserve the original cursor while migrating to independent channel progress.
  await db.query(`UPDATE pilot_meta SET cursors=jsonb_set(cursors,ARRAY[scope->>'channelId'],to_jsonb(cursor))
    WHERE cursor IS NOT NULL AND NOT (cursors ? (scope->>'channelId'))`);
  await db.query("UPDATE pilot_meta SET scope=$1", [config]);
  const reclassified = (
    await db.query(`UPDATE pilot_sources SET addressed=true,learned=false
    WHERE NOT addressed AND NOT deleted AND source->>'replyTo' IN
    (SELECT discord_id FROM pilot_outbox WHERE status='sent') RETURNING id`)
  ).rows.map((r) => r.id);
  const meta = async () => (await db.query("SELECT * FROM pilot_meta")).rows[0];
  const sources = async () =>
    (await db.query("SELECT * FROM pilot_sources ORDER BY id::numeric")).rows;
  const eligible = async () => (await sources()).filter((s) => !s.deleted);
  // Retired preference rows remain audit history; they no longer filter or delete sources.
  const optedOut = async () => false;
  let transactionTail = Promise.resolve();
  async function transaction(fn) {
    const previous = transactionTail;
    let release;
    transactionTail = new Promise((accept) => {
      release = accept;
    });
    await previous;
    try {
      await db.query("BEGIN");
      try {
        const value = await fn();
        await db.query("COMMIT");
        return value;
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    } finally {
      release();
    }
  }
  async function invalidate(ids, { requeueHistory = true } = {}) {
    await db.query(
      "UPDATE pilot_meta SET epoch=epoch+1,rebuild=true,relearning=true,invalid_sources=ARRAY(SELECT DISTINCT unnest(invalid_sources || $1::text[]))",
      [ids],
    );
    await db.query("UPDATE pilot_work SET status='stale' WHERE status='prepared'");
    await db.query("DELETE FROM pilot_outbox WHERE status='ready'");
    if (requeueHistory)
      await db.query(
        `UPDATE pilot_history_episodes SET status='queued',failure_count=0,next_attempt_at=NULL
       WHERE (read_ids || context_ids) && $1::text[] OR EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(manifest->'sourceIds')='array'
           THEN manifest->'sourceIds' ELSE '[]'::jsonb END) AS target(id) WHERE target.id=ANY($1::text[]))`,
        [ids],
      );
  }
  async function ingest(source, addressed = false, learnable = true) {
    if (
      !snowflake(source.id) ||
      !snowflake(source.guildId) ||
      !snowflake(source.channelId) ||
      !snowflake(source.authorId) ||
      typeof source.content !== "string" ||
      source.content.length > 16000 ||
      !Number.isFinite(Date.parse(source.createdAt))
    )
      throw new Error("Invalid source record");
    const hash = digest(JSON.stringify(source));
    await transaction(async () => {
      const previous = (await db.query("SELECT * FROM pilot_sources WHERE id=$1", [source.id]))
        .rows[0];
      if (previous?.hash === hash && !previous.deleted) {
        if (
          (addressed && !previous.addressed) ||
          (learnable && !previous.learnable && !previous.evidence_excluded)
        )
          await db.query(
            `UPDATE pilot_sources SET addressed=addressed OR $2,
             learnable=CASE WHEN evidence_excluded THEN false ELSE learnable OR $3 END,
             learned=CASE WHEN evidence_excluded THEN learned ELSE false END WHERE id=$1`,
            [source.id, addressed, learnable],
          );
        return;
      }
      await db.query(
        `INSERT INTO pilot_sources(id,source,hash,addressed,learnable,learned) VALUES($1,$2,$3,$4,$5,NOT $5)
        ON CONFLICT(id) DO UPDATE SET source=$2,hash=$3,deleted=false,learned=false,addressed=pilot_sources.addressed OR $4,learnable=CASE WHEN pilot_sources.evidence_excluded THEN false ELSE pilot_sources.learnable OR $5 END`,
        [source.id, source, hash, addressed, learnable],
      );
      if (previous) await invalidate([source.id]);
    });
  }
  async function remove(id) {
    await transaction(async () => {
      const changed = await db.query(
        "UPDATE pilot_sources SET deleted=true,source=jsonb_set(source,'{content}','null') WHERE id=$1 AND NOT deleted",
        [id],
      );
      if (changed.rowCount) await invalidate([id]);
    });
  }
  async function holdSource(id) {
    if (!snowflake(id)) throw new Error("Invalid correction source ID");
    return transaction(async () => {
      const source = (
        await db.query("SELECT deleted FROM pilot_sources WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!source || source.deleted) return false;
      const held = await db.query(
        "INSERT INTO pilot_source_holds(source_id,reason) VALUES($1,'correction-open') ON CONFLICT DO NOTHING RETURNING source_id",
        [id],
      );
      if (held.rowCount) await invalidate([id], { requeueHistory: false });
      return Boolean(held.rowCount);
    });
  }
  async function excludeCorrectionRequestEvidence(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !snowflake(id)))
      throw new Error("Invalid correction request source IDs");
    return transaction(async () => {
      const changed = (
        await db.query(
          `UPDATE pilot_sources SET evidence_excluded=true,learnable=false,learned=true
           WHERE id=ANY($1::text[]) AND NOT deleted AND NOT evidence_excluded RETURNING id`,
          [ids],
        )
      ).rows.map((row) => row.id);
      if (changed.length) await invalidate(changed, { requeueHistory: false });
      return changed;
    });
  }
  const optOut = async () => {}; // Deprecated compatibility hook; no state mutation.
  async function next() {
    const direct = (
      await db.query(
        `SELECT s.*, ${generationAttempts} FROM pilot_sources s WHERE NOT deleted AND addressed AND learnable AND NOT evidence_excluded
        AND ${generationReady}
        AND source->>'guildId'=$1 AND (source->>'channelId'=ANY($2::text[])
          OR EXISTS(SELECT 1 FROM pilot_live_threads t WHERE t.channel_id=source->>'channelId'
            AND t.guild_id=$1 AND t.parent_id=ANY($2::text[])))
        AND NOT EXISTS(SELECT 1 FROM pilot_source_holds h WHERE h.source_id=s.id)
        AND NOT EXISTS(SELECT 1 FROM pilot_outbox o WHERE o.source_id=s.id)
        ORDER BY id::numeric LIMIT 1`,
        [config.guildId, replyChannels(config)],
      )
    ).rows[0];
    if (direct) return { rows: [direct], replyTo: direct.id };
    const rows = (
      await db.query(
        `SELECT s.*, ${generationAttempts} FROM pilot_sources s WHERE NOT deleted AND NOT learned AND learnable AND NOT evidence_excluded
         AND ${generationReady}
         AND NOT EXISTS(SELECT 1 FROM pilot_source_holds h WHERE h.source_id=s.id)
         ORDER BY id::numeric LIMIT 12`,
      )
    ).rows;
    if (!rows.length) {
      await db.query("UPDATE pilot_meta SET relearning=false");
      return null;
    }
    const batch = [];
    for (const row of rows) {
      if (batch.length && row.addressed) break;
      batch.push(row);
      if (batch.length === 12) break;
    }
    return { rows: batch, replyTo: null };
  }
  async function prepare(
    epoch,
    batch,
    candidate,
    reply,
    validationIds = [],
    historyProjection = null,
  ) {
    const id = randomUUID();
    await transaction(async () => {
      if ((await meta()).epoch !== epoch)
        throw new Error("Source revision changed during generation");
      let savedProjection = null;
      if (historyProjection) {
        if (
          !batch.historyEpisode ||
          historyProjection.historyEpisodeId !== batch.historyEpisode ||
          !Array.isArray(historyProjection.sourceIds) ||
          !Array.isArray(historyProjection.contextIds) ||
          !historyProjection.sourceDigests ||
          typeof candidate?.content !== "string"
        )
          throw new Error("Invalid manifest-bound historical projection");
        const directSources = batch.rows.map((row) => row.source);
        const contextSources = batch.context?.surroundingMessages ?? [];
        const selected = [...directSources, ...contextSources];
        const selectedHashes = new Map(
          selected.map((source) => [source.id, digest(JSON.stringify(source))]),
        );
        const expectedIds = [...historyProjection.sourceIds, ...historyProjection.contextIds];
        const actualIds = selected.map((source) => source?.id);
        if (
          actualIds.length !== expectedIds.length ||
          new Set(actualIds).size !== actualIds.length ||
          expectedIds.some((sourceId) => !actualIds.includes(sourceId)) ||
          selected.some(
            (source) => historyProjection.sourceDigests[source.id] !== sourceFingerprint(source),
          )
        )
          throw new Error("Historical projection selection changed before memory commit");
        const currentSources = (
          await db.query(
            "SELECT id,source,hash,deleted FROM pilot_sources WHERE id=ANY($1::text[]) FOR SHARE",
            [expectedIds],
          )
        ).rows;
        if (
          currentSources.length !== expectedIds.length ||
          currentSources.some(
            (source) =>
              source.deleted ||
              sourceFingerprint(source.source) !== historyProjection.sourceDigests[source.id] ||
              source.hash !== selectedHashes.get(source.id),
          )
        )
          throw new Error("Historical projection sources changed before memory commit");
        savedProjection = {
          ...historyProjection,
          historyWorkId: id,
          memoryCandidateDigest: canonicalDigest(candidate),
          memoryCandidateRevision: digest(candidate.content),
          memoryExpectedRevision: candidate.expectedRevision ?? null,
        };
      }
      await db.query(
        `INSERT INTO pilot_work(id,epoch,source_ids,candidate,reply_to,reply,history_episode,validation_ids,history_projection)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          id,
          epoch,
          batch.rows.map((r) => r.id),
          candidate,
          batch.replyTo,
          reply,
          batch.historyEpisode ?? null,
          validationIds,
          savedProjection ? JSON.stringify(savedProjection) : null,
        ],
      );
    });
    return id;
  }
  async function queueReply(sourceId, reply, receipt = null) {
    if (!snowflake(sourceId) || typeof reply !== "string" || !reply.trim() || reply.length > 2000)
      throw new Error("Invalid deterministic pilot reply");
    let receiptJson = null;
    if (receipt !== null) {
      if (typeof receipt !== "object" || Array.isArray(receipt))
        throw new Error("Invalid deterministic pilot receipt");
      try {
        receiptJson = JSON.stringify(receipt);
      } catch {
        throw new Error("Invalid deterministic pilot receipt");
      }
      if (typeof receiptJson !== "string" || receiptJson.length > 16000)
        throw new Error("Invalid deterministic pilot receipt");
    }
    return transaction(async () => {
      const source = (
        await db.query("SELECT deleted FROM pilot_sources WHERE id=$1 FOR UPDATE", [sourceId])
      ).rows[0];
      if (!source || source.deleted) throw new Error("Deterministic reply source is unavailable");
      const epoch = (await meta()).epoch;
      const result = await db.query(
        `INSERT INTO pilot_outbox(source_id,content,epoch,receipt) VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT(source_id) DO NOTHING RETURNING source_id`,
        [sourceId, reply.trim(), epoch, receiptJson],
      );
      return { queued: result.rowCount === 1, epoch };
    });
  }
  async function finish(memory, { onHistoricalFailure } = {}) {
    const result = { completed: [], deferred: [] };
    for (const work of (
      await db.query("SELECT * FROM pilot_work WHERE status='prepared' ORDER BY created_at")
    ).rows) {
      try {
        if (work.epoch !== (await meta()).epoch) throw new Error("Prepared memory epoch mismatch");
        if (typeof work.candidate.content !== "string")
          throw Object.assign(new Error("Invalid prepared memory candidate content"), {
            code: "HISTORY_CANDIDATE_INVALID",
          });
        const current = await memory.read();
        if (
          current.revision !== digest(work.candidate.content) &&
          current.revision !== work.candidate.expectedRevision
        )
          throw new Error("Prepared memory conflicts with current note; operator review required");
        await memory.write(
          { content: work.candidate.content, expectedRevision: current.revision },
          {
            audit: work.candidate.audit,
            workId: work.id,
            historyEpisode: work.history_episode,
            sourceIds: work.source_ids,
          },
        );
      } catch (error) {
        if (!work.history_episode || !onHistoricalFailure) throw error;
        let current;
        try {
          current = await memory.read();
        } catch {
          throw error;
        }
        const candidateRevision =
          typeof work.candidate.content === "string" ? digest(work.candidate.content) : null;
        const landed = candidateRevision !== null && current.revision === candidateRevision;
        if (!landed && current.revision !== work.candidate.expectedRevision) throw error;
        const action = await onHistoricalFailure(work, error, {
          landed,
          currentRevision: current.revision,
          candidateRevision,
          parentRevision: work.candidate.expectedRevision,
        });
        if (action === "deferred") {
          result.deferred.push(work.id);
          continue;
        }
        if (action !== "reconcile" || !landed) throw error;
      }
      // The durable candidate precedes MemFS. A crash after the file commit is
      // recovered by its content hash, without applying a second memory update.
      await transaction(async () => {
        await db.query("UPDATE pilot_sources SET learned=true WHERE id=ANY($1::text[])", [
          work.source_ids,
        ]);
        if (work.reply_to)
          await db.query(
            `INSERT INTO pilot_outbox(source_id,content,epoch) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
            [work.reply_to, work.reply, work.epoch],
          );
        await db.query("UPDATE pilot_work SET status='done' WHERE id=$1", [work.id]);
        if (work.history_episode)
          await db.query(
            `UPDATE pilot_history_episodes SET status='done',work_id=$2,read_ids=$3,completed_at=now()
             WHERE id=$1`,
            [work.history_episode, work.id, work.source_ids],
          );
        if (work.history_projection) {
          const binding =
            typeof work.history_projection === "string"
              ? JSON.parse(work.history_projection)
              : work.history_projection;
          const projected = await db.query(
            `UPDATE pilot_knowledge_episodes SET derivation_status='pending',derivation_work_id=$2,
             derivation_binding=$3::jsonb,derivation_reason=NULL,derivation_updated_at=clock_timestamp()
             WHERE id=$1 AND manifest_id=$4 AND manifest_generation=$5 AND snapshot_digest=$6`,
            [
              binding.episodeId,
              work.id,
              JSON.stringify(binding),
              binding.manifestId,
              binding.manifestGeneration,
              binding.episodeDigest,
            ],
          );
          if (projected.rowCount !== 1)
            throw new Error("Manifest-bound historical projection lost its episode snapshot");
        }
      });
      result.completed.push(work.id);
    }
    return result;
  }
  return {
    db,
    transaction,
    meta,
    sources,
    eligible,
    optedOut,
    ingest,
    remove,
    holdSource,
    excludeCorrectionRequestEvidence,
    optOut,
    next,
    prepare,
    queueReply,
    finish,
    reclassified,
    async findSources(ids) {
      return (
        await db.query(
          `SELECT s.source FROM pilot_sources s WHERE NOT s.deleted AND s.id=ANY($1::text[])
           AND NOT EXISTS(SELECT 1 FROM pilot_source_holds h WHERE h.source_id=s.id)`,
          [ids],
        )
      ).rows.map((r) => r.source);
    },
    async validationSources(ids) {
      if (ids)
        return (await db.query("SELECT * FROM pilot_sources WHERE id=ANY($1::text[])", [ids])).rows;
      // ponytail: twenty recent + twenty least-recently checked records per cycle.
      // Cold sources are eventually reconciled; evidence used in a reply is also
      // fetched explicitly before memory is read and again before delivery.
      return (
        await db.query(`SELECT * FROM pilot_sources WHERE id IN (
        (SELECT id FROM pilot_sources WHERE NOT deleted AND learnable ORDER BY id::numeric DESC LIMIT 20)
        UNION (SELECT id FROM pilot_sources WHERE NOT deleted ORDER BY checked_at NULLS FIRST,id::numeric LIMIT 20))`)
      ).rows;
    },
    async checked(id) {
      await db.query("UPDATE pilot_sources SET checked_at=now() WHERE id=$1", [id]);
    },
    async isHeld(id) {
      return Boolean(
        (await db.query("SELECT 1 FROM pilot_source_holds WHERE source_id=$1", [id])).rowCount,
      );
    },
    async migrateMemory() {
      await transaction(async () => {
        await db.query(
          "UPDATE pilot_meta SET memory_version=2,relearning=true,rebuild=false,invalid_sources='{}',epoch=epoch+1",
        );
        await db.query("UPDATE pilot_sources SET learned=false WHERE NOT deleted AND learnable");
        await db.query("UPDATE pilot_work SET status='stale' WHERE status='prepared'");
        await db.query("DELETE FROM pilot_outbox WHERE status='ready'");
      });
    },
    async isAddressed(source, botId, readParent) {
      const known =
        new RegExp(`<@!?${botId}>`).test(source.content) ||
        Boolean(
          source.replyTo &&
          (
            await db.query("SELECT 1 FROM pilot_outbox WHERE discord_id=$1 AND status='sent'", [
              source.replyTo,
            ])
          ).rowCount,
        );
      if (known || !source.replyTo || !readParent) return known;
      const parent = await readParent(source.channelId, source.replyTo);
      return (
        parent?.id === source.replyTo &&
        parent.channel_id === source.channelId &&
        parent.author?.id === botId
      );
    },
    async context(beforeId) {
      const trigger = (await db.query("SELECT source FROM pilot_sources WHERE id=$1", [beforeId]))
        .rows[0]?.source;
      const channelId = trigger?.channelId ?? config.channelId;
      const recent = (
        await db.query(
          `SELECT source FROM pilot_sources WHERE NOT deleted
        AND source->>'channelId'=$1 AND id::numeric < $2::numeric ORDER BY id::numeric DESC LIMIT 8`,
          [channelId, beforeId],
        )
      ).rows
        .reverse()
        .map((r) => ({ kind: "source", ...r.source }));
      const replies = (
        await db.query(
          `SELECT source_id,content FROM pilot_outbox WHERE status='sent'
        AND epoch=(SELECT epoch FROM pilot_meta) AND source_id::numeric < $1::numeric
        AND EXISTS(SELECT 1 FROM pilot_sources s WHERE s.id=source_id AND s.source->>'channelId'=$2)
        ORDER BY source_id::numeric DESC LIMIT 4`,
          [beforeId, channelId],
        )
      ).rows.reverse();
      return {
        priorMessages: recent,
        priorBotReplies: replies,
        note: "Bot replies are conversational context, never evidence about members.",
      };
    },
    async registerThreads(threads, forumIds) {
      if (
        !forumIds.every((id) => replyChannels(config).includes(id)) ||
        threads.some(
          (t) =>
            !snowflake(t.id) ||
            !forumIds.includes(t.parent_id) ||
            t.guild_id !== config.guildId ||
            t.type !== 11,
        )
      )
        throw new Error("Invalid live forum thread");
      await transaction(async () => {
        const current = await meta();
        for (const thread of threads) {
          const added = await db.query(
            `INSERT INTO pilot_live_threads(channel_id,parent_id,guild_id)
            VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING channel_id`,
            [thread.id, thread.parent_id, config.guildId],
          );
          // A newly discovered discussion after forum activation starts live, including its first post.
          if (added.rowCount && current.cursors[thread.parent_id])
            await db.query(
              "UPDATE pilot_meta SET cursors=jsonb_set(cursors,ARRAY[$1::text],to_jsonb('00000000000000000'::text))",
              [thread.id],
            );
        }
        for (const id of forumIds)
          await db.query(
            "UPDATE pilot_meta SET cursors=jsonb_set(cursors,ARRAY[$1::text],to_jsonb('00000000000000000'::text)) WHERE NOT (cursors ? $1)",
            [id],
          );
      });
    },
    async replyChannelAllowed(channelId) {
      return (
        replyChannels(config).includes(channelId) ||
        Boolean(
          (
            await db.query(
              "SELECT 1 FROM pilot_live_threads WHERE channel_id=$1 AND guild_id=$2 AND parent_id=ANY($3::text[])",
              [channelId, config.guildId, replyChannels(config)],
            )
          ).rowCount,
        )
      );
    },
    async cursor(id, channelId = config.channelId) {
      if (!snowflake(id) || !(await this.replyChannelAllowed(channelId)))
        throw new Error("Invalid live cursor");
      await db.query(
        `UPDATE pilot_meta SET cursors=jsonb_set(cursors,ARRAY[$2::text],to_jsonb($1::text)),
        cursor=CASE WHEN $2=scope->>'channelId' THEN $1::text ELSE cursor END
        WHERE (cursors->>$2) IS NULL OR (cursors->>$2)::numeric < $1::text::numeric`,
        [id, channelId],
      );
    },
    async reset(memory) {
      if (!(await meta()).rebuild) return;
      if (memory.invalidate) {
        const affected = await memory.affected((await meta()).invalid_sources);
        await db.query(
          "UPDATE pilot_sources SET learned=false WHERE NOT deleted AND learnable AND id=ANY($1::text[])",
          [affected],
        );
        await memory.invalidate((await meta()).invalid_sources);
      } else {
        const current = await memory.read();
        await memory.write({ content: emptyMemory, expectedRevision: current.revision });
        await db.query("UPDATE pilot_sources SET learned=false WHERE NOT deleted AND learnable");
      }
      await db.query("UPDATE pilot_meta SET rebuild=false,invalid_sources='{}'");
      return true;
    },
  };
}

export async function deliver(store, discord, botId, channelId, record) {
  const pending = (
    await store.db.query(
      "SELECT * FROM pilot_outbox WHERE status IN ('ready','sending') ORDER BY source_id::numeric",
    )
  ).rows;
  const scope = validateScope((await store.meta()).scope);
  for (const row of pending) {
    const source = (
      await store.db.query("SELECT * FROM pilot_sources WHERE id=$1", [row.source_id])
    ).rows[0];
    const targetChannel = source?.source?.channelId;
    if (
      !source ||
      source.source.guildId !== scope.guildId ||
      !(
        replyChannels(scope).includes(targetChannel) ||
        (await store.replyChannelAllowed?.(targetChannel))
      )
    ) {
      await store.db.query(
        "UPDATE pilot_outbox SET status='held',error='Source outside live reply scope' WHERE source_id=$1",
        [row.source_id],
      );
      continue;
    }
    if (row.status === "sending") {
      // Nonce de-duplication lasts only minutes. Reconcile by reply reference;
      // an ambiguous send is HELD, never blindly retried even after a long outage.
      const messages = await discord.after(targetChannel, row.source_id);
      const matches = messages.filter(
        (m) => m.author.id === botId && m.message_reference?.message_id === row.source_id,
      );
      await store.db.query(
        "UPDATE pilot_outbox SET status=$2,discord_id=$3,error=$4 WHERE source_id=$1",
        [
          row.source_id,
          matches.length === 1 ? "sent" : "held",
          matches.length === 1 ? matches[0].id : null,
          matches.length === 1
            ? null
            : "Interrupted send could not be uniquely reconciled; do not resend automatically",
        ],
      );
      await record({
        type: "delivery_recovery",
        sourceId: row.source_id,
        matches: matches.map((m) => m.id),
        ...(row.receipt ? { receipt: row.receipt } : {}),
      });
      continue;
    }
    if (!source || source.deleted || row.epoch !== (await store.meta()).epoch) {
      await store.db.query(
        "UPDATE pilot_outbox SET status='held',error='Stale or deleted source' WHERE source_id=$1",
        [row.source_id],
      );
      continue;
    }
    await store.db.query(
      "UPDATE pilot_outbox SET status='sending',attempted_at=now() WHERE source_id=$1",
      [row.source_id],
    );
    const sent = await discord.send(targetChannel, {
      content: row.content,
      nonce: row.source_id,
      enforce_nonce: true,
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: {
        message_id: row.source_id,
        channel_id: targetChannel,
        fail_if_not_exists: true,
      },
    });
    await store.db.query("UPDATE pilot_outbox SET status='sent',discord_id=$2 WHERE source_id=$1", [
      row.source_id,
      sent.id,
    ]);
    await record({
      type: "discord_reply",
      sourceId: row.source_id,
      id: sent.id,
      content: row.content,
      ...(row.receipt ? { receipt: row.receipt } : {}),
    });
  }
}
