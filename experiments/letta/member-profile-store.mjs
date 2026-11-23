import {
  PROFILE_VERSION,
  classifyStatement,
  evidenceDigest,
  freshnessOf,
  topicKey,
} from "./member-profile.mjs";

export const MEMBER_EVIDENCE_SQL = `
  SELECT s.guild_id AS "guildId", s.subject_member_id AS "memberId",
    s.statement_id AS "statementId",
    s.statement_kind::text AS kind,
    s.normalized_topic AS topic,
    s.normalized_subject AS subject,
    s.normalized_proposition AS proposition,
    s.exact_quote AS quote,
    s.extracted_assertion AS assertion,
    s.source_message_id AS "messageId",
    s.source_revision_id AS "revisionId",
    s.source_occurred_at AS "occurredAt",
    s.extractor_version AS "extractorVersion",
    s.fact_identity AS "factIdentity",
    r.channel_id AS "channelId",
    r.is_current AS "isCurrent",
    r.tombstoned_at AS "tombstonedAt",
    r.content_hash AS "revisionHash",
    (r.revision_id IS NOT NULL) AS "revisionFound",
    (m.message_id IS NOT NULL) AS "messageFound",
    m.deleted_at AS "deletedAt",
    m.content_hash AS "messageHash",
    m.content AS "sourceContent",
    m.author_id AS "messageAuthorId",
    m.author_display_name AS "authorName",
    m.created_at AS "sourceCreatedAt",
    m.edited_at AS "sourceEditedAt",
    m.reply_to_message_id AS "replyTo",
    m.channel_id AS "messageChannelId",
    COALESCE(parent_context.sources, '[]'::jsonb) AS "sourceContext",
    (EXISTS (
      SELECT 1 FROM v2_invalidations i
      WHERE i.guild_id = s.guild_id
        AND i.artifact_id = s.statement_id
    ) OR (EXISTS (
      SELECT 1 FROM v2_validity_intervals v
      WHERE v.guild_id = s.guild_id AND v.member_id = s.subject_member_id
        AND v.artifact_id = s.statement_id
    ) AND NOT EXISTS (
      SELECT 1 FROM v2_validity_intervals v
      WHERE v.guild_id = s.guild_id AND v.member_id = s.subject_member_id
        AND v.artifact_id = s.statement_id AND v.lifecycle_state = 'current'
        AND v.source_valid_to IS NULL AND v.system_recorded_to IS NULL
    ))) AS invalidated
  FROM v2_statements s
  LEFT JOIN v2_source_revisions r
    ON r.guild_id = s.guild_id
   AND r.message_id = s.source_message_id
   AND r.revision_id = s.source_revision_id
   AND r.author_id = s.subject_member_id
  LEFT JOIN messages m
    ON m.guild_id = s.guild_id
   AND m.message_id = s.source_message_id
  LEFT JOIN LATERAL (
    SELECT jsonb_build_array(jsonb_build_object(
      'guildId', p.guild_id,
      'messageId', p.message_id,
      'memberId', p.author_id,
      'authorName', p.author_display_name,
      'channelId', p.channel_id,
      'occurredAt', p.created_at,
      'editedAt', p.edited_at,
      'contentHash', p.content_hash,
      'revisionId', COALESCE(pr.revision_id, 'archive:' || p.content_hash),
      'content', p.content,
      'visible', true,
      'freshness', 'current'
    )) AS sources
    FROM messages p
    LEFT JOIN LATERAL (
      SELECT vr.revision_id
      FROM v2_source_revisions vr
      WHERE vr.guild_id = p.guild_id AND vr.message_id = p.message_id
        AND vr.channel_id = p.channel_id AND vr.author_id = p.author_id
        AND vr.is_current AND vr.tombstoned_at IS NULL
        AND vr.content_hash = p.content_hash
      ORDER BY vr.revision_id DESC
      LIMIT 1
    ) pr ON true
    WHERE p.guild_id = m.guild_id AND p.channel_id = m.channel_id
      AND p.channel_id = r.channel_id AND p.message_id = m.reply_to_message_id
      AND p.deleted_at IS NULL AND p.content IS NOT NULL AND p.content_hash IS NOT NULL
  ) parent_context ON true
  WHERE s.guild_id = $1 AND s.subject_member_id = $2
    AND ($3::text[] IS NULL OR r.channel_id = ANY($3::text[]))
  ORDER BY s.source_occurred_at, s.statement_id`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS member_profile_heads (
    guild_id text NOT NULL,
    member_id text NOT NULL,
    visibility_scope text NOT NULL DEFAULT 'all',
    run_id text,
    profile_version text NOT NULL,
    processing_state text NOT NULL,
    evidence_digest text,
    previous_digest text,
    statement_count integer,
    previous_statement_count integer,
    started_at timestamptz,
    completed_at timestamptz,
    error_code text,
    PRIMARY KEY (guild_id, member_id, visibility_scope),
    CHECK (processing_state IN ('running', 'complete', 'failed')),
    CHECK (processing_state <> 'complete' OR completed_at IS NOT NULL)
  );
  CREATE TABLE IF NOT EXISTS member_profile_annotations (
    guild_id text NOT NULL,
    statement_id text NOT NULL,
    member_id text NOT NULL,
    visibility_scope text NOT NULL DEFAULT 'all',
    profile_version text NOT NULL,
    input_digest text NOT NULL,
    topic_key text NOT NULL,
    discourse_role text NOT NULL,
    freshness text NOT NULL,
    source_message_id text NOT NULL,
    source_revision_id text NOT NULL,
    channel_id text,
    extractor_version text NOT NULL,
    occurred_at timestamptz,
    annotated_at timestamptz NOT NULL,
    PRIMARY KEY (guild_id, statement_id, visibility_scope)
  );
  CREATE INDEX IF NOT EXISTS member_profile_annotations_member_idx
    ON member_profile_annotations (guild_id, member_id);
  ALTER TABLE member_profile_heads
    ADD COLUMN IF NOT EXISTS visibility_scope text NOT NULL DEFAULT 'all';
  ALTER TABLE member_profile_heads ADD COLUMN IF NOT EXISTS run_id text;
  ALTER TABLE member_profile_annotations
    ADD COLUMN IF NOT EXISTS visibility_scope text NOT NULL DEFAULT 'all';
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'member_profile_heads'::regclass
        AND conname = 'member_profile_heads_pkey'
        AND pg_get_constraintdef(oid) NOT LIKE '%visibility_scope%') THEN
      ALTER TABLE member_profile_heads DROP CONSTRAINT member_profile_heads_pkey;
      ALTER TABLE member_profile_heads ADD PRIMARY KEY (guild_id, member_id, visibility_scope);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'member_profile_annotations'::regclass
        AND conname = 'member_profile_annotations_pkey'
        AND pg_get_constraintdef(oid) NOT LIKE '%visibility_scope%') THEN
      ALTER TABLE member_profile_annotations DROP CONSTRAINT member_profile_annotations_pkey;
      ALTER TABLE member_profile_annotations ADD PRIMARY KEY (guild_id, statement_id, visibility_scope);
    END IF;
  END $$;
  CREATE TABLE IF NOT EXISTS member_profile_reviews (
    review_id bigserial PRIMARY KEY,
    guild_id text NOT NULL,
    member_id text NOT NULL,
    visibility_scope text NOT NULL,
    profile_version text NOT NULL,
    statement_id text NOT NULL,
    input_digest text NOT NULL,
    review_digest text NOT NULL,
    record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
    recorded_at timestamptz NOT NULL,
    UNIQUE (guild_id, member_id, visibility_scope, profile_version,
      statement_id, input_digest, review_digest)
  );
  CREATE INDEX IF NOT EXISTS member_profile_reviews_member_idx
    ON member_profile_reviews (guild_id, member_id, visibility_scope, review_id);
  CREATE OR REPLACE FUNCTION member_profile_reviews_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Member profile reviews are append-only';
    END $$;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'member_profile_reviews'::regclass
        AND tgname = 'member_profile_reviews_immutable') THEN
      CREATE TRIGGER member_profile_reviews_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON member_profile_reviews
        FOR EACH STATEMENT EXECUTE FUNCTION member_profile_reviews_immutable();
    END IF;
  END $$;
  CREATE TABLE IF NOT EXISTS member_profile_schema (version integer PRIMARY KEY);
  INSERT INTO member_profile_schema (version) VALUES (2) ON CONFLICT DO NOTHING;
`;

const clientQueues = new WeakMap();

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function scopedEvidenceDigest(rows, scope) {
  const digest = evidenceDigest(rows);
  return scope === "all" ? digest : hash(JSON.stringify([PROFILE_VERSION, scope, digest]));
}

export function profileScopeKey(visibleChannelIds) {
  if (visibleChannelIds == null) return "all";
  if (
    !Array.isArray(visibleChannelIds) ||
    visibleChannelIds.some((id) => typeof id !== "string" || !/^\d{17,20}$/.test(id))
  )
    throw new Error("Invalid member profile visibility scope");
  return hash(JSON.stringify([...new Set(visibleChannelIds)].sort()));
}

// Pools need a dedicated connection for transactions/session locks. Explicit
// clients are serialized locally as well: PostgreSQL session locks are reentrant
// on the same connection, so a lock alone cannot serialize two calls on one client.
async function withWriterClient(writer, operation) {
  if (writer instanceof pg.Pool) {
    const client = await writer.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }
  const prior = clientQueues.get(writer) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prior.catch(() => {}).then(() => gate);
  clientQueues.set(writer, tail);
  await prior.catch(() => {});
  try {
    return await operation(writer);
  } finally {
    release();
    if (clientQueues.get(writer) === tail) clientQueues.delete(writer);
  }
}

async function schemaReady(client) {
  const table = await client.query("SELECT to_regclass('public.member_profile_schema') AS name");
  if (!table.rows[0]?.name) return false;
  const version = await client.query("SELECT 1 FROM member_profile_schema WHERE version = 2");
  return version.rowCount === 1;
}

async function ensureSchema(client) {
  if (await schemaReady(client)) return;
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      "mudfut-member-profile-schema-v2",
    ]);
    // A peer may have finished installation while this client waited. Repeated
    // ALTER TABLEs would otherwise contend with live annotation transactions.
    if (!(await schemaReady(client))) await client.query(SCHEMA);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function withProfileOwnership(writer, input, operation) {
  const scope = profileScopeKey(input.visibleChannelIds);
  return withWriterClient(writer, async (client) => {
    await ensureSchema(client);
    const key = JSON.stringify(["member-profile", input.guildId, input.memberId, scope]);
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try {
      return await operation(client, scope);
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
        .catch(() => {});
    }
  });
}

export function isReadOnly(error) {
  return error?.code === "25006" || /read-only/i.test(error?.message ?? "");
}

export async function profileTablesReady(db) {
  const result = await db.query(`SELECT to_regclass('public.member_profile_heads') AS head,
    EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'member_profile_heads'
        AND column_name = 'visibility_scope') AS scoped`);
  return Boolean(result.rows[0]?.head && result.rows[0]?.scoped);
}

export async function ensureMemberProfileSchema(db) {
  await withWriterClient(db, ensureSchema);
}

export async function loadMemberEvidence(db, guildId, memberId, { visibleChannelIds } = {}) {
  profileScopeKey(visibleChannelIds);
  const { rows } = await db.query(MEMBER_EVIDENCE_SQL, [
    guildId,
    memberId,
    visibleChannelIds ?? null,
  ]);
  const allowed = visibleChannelIds == null ? null : new Set(visibleChannelIds);
  return rows
    .filter((row) => !allowed || allowed.has(row.channelId))
    .map((row) => ({ ...row, freshness: freshnessOf(row) }));
}

async function readHead(db, guildId, memberId, scope) {
  const { rows } = await db.query(
    `SELECT profile_version AS "profileVersion", processing_state AS "processingState",
      evidence_digest AS "evidenceDigest", previous_digest AS "previousDigest",
      statement_count AS "statementCount", previous_statement_count AS "previousStatementCount",
      started_at AS "startedAt", completed_at AS "completedAt", error_code AS "errorCode"
     FROM member_profile_heads WHERE guild_id = $1 AND member_id = $2 AND visibility_scope = $3`,
    [guildId, memberId, scope],
  );
  return rows[0] ?? null;
}

async function writeAnnotations(db, guildId, memberId, scope, rows, at) {
  const width = 15;
  for (let index = 0; index < rows.length; index += 80) {
    const part = rows.slice(index, index + 80);
    const values = [];
    const placeholders = part.map((row, rowIndex) => {
      const base = rowIndex * width;
      values.push(
        guildId,
        row.statementId,
        memberId,
        scope,
        PROFILE_VERSION,
        row.digest,
        topicKey(row.topic),
        classifyStatement(row).role,
        row.freshness,
        row.messageId,
        row.revisionId,
        row.channelId ?? null,
        row.extractorVersion,
        row.occurredAt,
        at,
      );
      return Array.from({ length: width }, (_, offset) => `$${base + offset + 1}`).join(", ");
    });
    await db.query(
      `INSERT INTO member_profile_annotations (
        guild_id, statement_id, member_id, visibility_scope, profile_version, input_digest, topic_key,
        discourse_role, freshness, source_message_id, source_revision_id, channel_id,
        extractor_version, occurred_at, annotated_at
      ) VALUES ${placeholders.map((placeholder) => `(${placeholder})`).join(", ")}
      ON CONFLICT (guild_id, statement_id, visibility_scope) DO UPDATE SET
        member_id = EXCLUDED.member_id,
        profile_version = EXCLUDED.profile_version,
        input_digest = EXCLUDED.input_digest,
        topic_key = EXCLUDED.topic_key,
        discourse_role = EXCLUDED.discourse_role,
        freshness = EXCLUDED.freshness,
        source_message_id = EXCLUDED.source_message_id,
        source_revision_id = EXCLUDED.source_revision_id,
        channel_id = EXCLUDED.channel_id,
        extractor_version = EXCLUDED.extractor_version,
        occurred_at = EXCLUDED.occurred_at,
        annotated_at = EXCLUDED.annotated_at
      WHERE member_profile_annotations.input_digest IS DISTINCT FROM EXCLUDED.input_digest`,
      values,
    );
  }
}

export async function maintainMemberProfile(writer, input) {
  return withProfileOwnership(writer, input, async (db, scope) => {
    const source = input.sourceDb ?? db;
    const options = { visibleChannelIds: input.visibleChannelIds };
    const now = input.now ?? new Date();
    const initial = await loadMemberEvidence(source, input.guildId, input.memberId, options);
    const digest = scopedEvidenceDigest(initial, scope);
    const head = await readHead(db, input.guildId, input.memberId, scope);
    if (
      !input.stopWhileRunning &&
      head?.processingState === "complete" &&
      head.profileVersion === PROFILE_VERSION &&
      head.evidenceDigest === digest
    ) {
      return {
        status: "unchanged",
        digest,
        statementCount: initial.length,
        completedAt: head.completedAt,
        changedBecause: null,
        scopeKey: scope,
      };
    }
    const runId = randomUUID();
    await db.query(
      `INSERT INTO member_profile_heads (
      guild_id, member_id, visibility_scope, run_id, profile_version, processing_state, evidence_digest,
      previous_digest, statement_count, previous_statement_count, started_at, completed_at, error_code
    ) VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, $9, $10, NULL, NULL)
    ON CONFLICT (guild_id, member_id, visibility_scope) DO UPDATE SET
      processing_state = 'running', profile_version = EXCLUDED.profile_version,
      run_id = EXCLUDED.run_id, started_at = EXCLUDED.started_at,
      completed_at = NULL, error_code = NULL`,
      [
        input.guildId,
        input.memberId,
        scope,
        runId,
        PROFILE_VERSION,
        head?.evidenceDigest ?? null,
        head?.previousDigest ?? null,
        head?.statementCount ?? null,
        head?.previousStatementCount ?? null,
        now,
      ],
    );
    if (input.stopWhileRunning) {
      const error = new Error("profile processing interrupted");
      error.code = "INTERRUPTED";
      throw error;
    }
    try {
      await db.query("BEGIN");
      const current = await loadMemberEvidence(source, input.guildId, input.memberId, options);
      const currentDigest = scopedEvidenceDigest(current, scope);
      if (currentDigest !== digest) {
        const error = new Error("profile evidence changed while it was being recorded");
        error.code = "EVIDENCE_CHANGED";
        throw error;
      }
      if (input.failBeforeCommit) {
        const error = new Error("profile processing failed");
        error.code = "FORCED_FAILURE";
        throw error;
      }
      const annotated = current.map((row) => ({ ...row, digest: evidenceDigest([row]) }));
      await writeAnnotations(db, input.guildId, input.memberId, scope, annotated, now);
      const final = await loadMemberEvidence(source, input.guildId, input.memberId, options);
      if (scopedEvidenceDigest(final, scope) !== currentDigest) {
        const error = new Error("profile evidence changed before commit");
        error.code = "EVIDENCE_CHANGED";
        throw error;
      }
      const previousDigest = head?.evidenceDigest ?? null;
      const changed = Boolean(previousDigest && previousDigest !== currentDigest);
      const completed = await db.query(
        `UPDATE member_profile_heads SET
        processing_state = 'complete', profile_version = $3, evidence_digest = $4,
        previous_digest = $5, statement_count = $6, previous_statement_count = $7,
        completed_at = $8, error_code = NULL
       WHERE guild_id = $1 AND member_id = $2 AND visibility_scope = $9 AND run_id = $10`,
        [
          input.guildId,
          input.memberId,
          PROFILE_VERSION,
          currentDigest,
          changed ? previousDigest : (head?.previousDigest ?? null),
          current.length,
          changed ? (head?.statementCount ?? null) : (head?.previousStatementCount ?? null),
          now,
          scope,
          runId,
        ],
      );
      if (completed.rowCount !== 1) {
        const error = new Error("Member profile maintenance ownership changed");
        error.code = "OWNERSHIP_CHANGED";
        throw error;
      }
      await db.query("COMMIT");
      return {
        status: changed ? "updated" : "recorded",
        digest: currentDigest,
        statementCount: current.length,
        previousStatementCount: changed ? (head?.statementCount ?? null) : null,
        changedBecause: changed ? "evidence-changed" : null,
        completedAt: now,
        scopeKey: scope,
      };
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      if (!isReadOnly(error)) {
        await db
          .query(
            `UPDATE member_profile_heads SET processing_state = 'failed', completed_at = NULL, error_code = $3
           WHERE guild_id = $1 AND member_id = $2 AND visibility_scope = $4 AND run_id = $5`,
            [
              input.guildId,
              input.memberId,
              String(error.code ?? "FAILED").slice(0, 80),
              scope,
              runId,
            ],
          )
          .catch(() => {});
      }
      throw error;
    }
  });
}

export async function ledgerState(db, guildId, memberId, options = {}) {
  if (!(await profileTablesReady(db)))
    return { ledger: "not-installed", updatedAt: null, changedBecause: null, stale: false };
  const rows = await loadMemberEvidence(options.sourceDb ?? db, guildId, memberId, options);
  const scope = profileScopeKey(options.visibleChannelIds);
  const digest = scopedEvidenceDigest(rows, scope);
  const head = await readHead(db, guildId, memberId, scope);
  if (!head)
    return { ledger: "not-installed", updatedAt: null, changedBecause: null, stale: false };
  if (head.processingState === "running")
    return { ledger: "running", updatedAt: null, changedBecause: null, stale: true };
  if (head.processingState === "failed")
    return { ledger: "failed", updatedAt: null, changedBecause: null, stale: true };
  const current = head.profileVersion === PROFILE_VERSION && head.evidenceDigest === digest;
  return {
    ledger: current ? "current" : "pending",
    updatedAt: head.completedAt instanceof Date ? head.completedAt.toISOString() : head.completedAt,
    changedBecause:
      head.previousDigest && head.previousDigest !== head.evidenceDigest
        ? "evidence-changed"
        : null,
    statementCount: head.statementCount,
    previousStatementCount: head.previousStatementCount,
    stale: !current,
  };
}

export async function annotationCount(db, guildId, memberId, { visibleChannelIds } = {}) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n, max(annotated_at) AS at
     FROM member_profile_annotations WHERE guild_id = $1 AND member_id = $2 AND visibility_scope = $3`,
    [guildId, memberId, profileScopeKey(visibleChannelIds)],
  );
  return rows[0];
}
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  return value;
}

export async function saveProfileReview(writer, input) {
  if (!Array.isArray(input.records)) throw new Error("Profile review records must be an array");
  const records = input.records.map((entry) => {
    const wrapped = entry != null && Object.hasOwn(entry, "record");
    if (
      wrapped &&
      (!entry.record || typeof entry.record !== "object" || Array.isArray(entry.record))
    )
      throw new Error("Invalid profile review record");
    const payload = wrapped
      ? { ...entry.record, statementId: entry.statementId, inputDigest: entry.inputDigest }
      : entry;
    if (
      !entry ||
      typeof entry.statementId !== "string" ||
      !entry.statementId.trim() ||
      typeof entry.inputDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.inputDigest) ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      throw new Error("Invalid profile review record");
    if (
      (payload.guildId != null && payload.guildId !== input.guildId) ||
      (payload.memberId != null && payload.memberId !== input.memberId)
    )
      throw new Error("Profile review identity does not match its storage scope");
    const record = JSON.stringify(canonicalJson(JSON.parse(JSON.stringify(payload))));
    return { ...entry, record, reviewDigest: hash(record) };
  });
  return withProfileOwnership(writer, input, async (client, scope) => {
    await client.query("BEGIN");
    try {
      let inserted = 0;
      for (const entry of records) {
        const result = await client.query(
          `INSERT INTO member_profile_reviews
            (guild_id, member_id, visibility_scope, profile_version, statement_id,
             input_digest, review_digest, record, recorded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
           ON CONFLICT (guild_id, member_id, visibility_scope, profile_version,
             statement_id, input_digest, review_digest) DO NOTHING`,
          [
            input.guildId,
            input.memberId,
            scope,
            PROFILE_VERSION,
            entry.statementId,
            entry.inputDigest,
            entry.reviewDigest,
            entry.record,
            input.now ?? new Date(),
          ],
        );
        inserted += result.rowCount;
      }
      await client.query("COMMIT");
      return { inserted, scopeKey: scope };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

export async function loadProfileReviews(writer, input) {
  const scope = profileScopeKey(input.visibleChannelIds);
  const exists = await writer.query(
    "SELECT to_regclass('public.member_profile_reviews') AS reviews",
  );
  if (!exists.rows[0]?.reviews) return [];
  const result = await writer.query(
    `SELECT DISTINCT ON (statement_id, input_digest)
       statement_id AS "statementId", input_digest AS "inputDigest", record,
       recorded_at AS "recordedAt", review_id::text AS "reviewId"
     FROM member_profile_reviews
     WHERE guild_id = $1 AND member_id = $2 AND visibility_scope = $3 AND profile_version = $4
     ORDER BY statement_id, input_digest, review_id DESC`,
    [input.guildId, input.memberId, scope, PROFILE_VERSION],
  );
  return result.rows.map((row) => row.record);
}
