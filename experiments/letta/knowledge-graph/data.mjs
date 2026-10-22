import pg from "pg";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { assertPrivateState } from "../runtime.mjs";
import { buildGraph } from "./model.mjs";

export async function readConfig(directory, filename) {
  assertPrivateState(directory);
  const path = join(directory, filename),
    stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error("Database configuration must be a private regular file outside the repository");
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readOnly(config, read, Client = pg.Client) {
  const db = new Client({
    ...config,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    application_name: "mudfut-knowledge-graph-readonly",
  });
  try {
    await db.connect();
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET LOCAL statement_timeout='10s'");
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout='15s'");
    const value = await read(db);
    await db.query("COMMIT");
    return value;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await db.end().catch(() => {});
  }
}

async function bounded(db, sql, params, limit = 5000) {
  const { rows } = await db.query(`${sql} LIMIT ${limit + 1}`, params);
  if (rows.length > limit)
    throw new Error(
      "Snapshot exceeds its bounded read limit; narrow the adapter query before continuing",
    );
  return rows;
}

// ponytail: materialize the bounded annotation selection in memory; beyond 2,000 versions, upgrade to keyset pagination and neighborhood queries.
export async function readPilot(db) {
  const annotations = await bounded(
    db,
    "SELECT id,revision,manifest_id,episode_id,source_ids,candidate,candidate_digest,status,created_at FROM pilot_knowledge_annotations ORDER BY created_at,id,revision",
    [],
    2000,
  );
  const ids = [
    ...new Set(
      annotations.flatMap((row) => [...row.source_ids, ...(row.candidate.contextSourceIds ?? [])]),
    ),
  ];
  const sources = await bounded(
    db,
    "SELECT id,source,source_digest,revision,generation,correction_generation,deleted,updated_at FROM pilot_knowledge_sources WHERE id=ANY($1::text[]) ORDER BY id",
    [ids],
  );
  const revisions = await bounded(
    db,
    "SELECT source_id,revision,source,source_digest,created_at FROM pilot_knowledge_source_revisions WHERE source_id=ANY($1::text[]) ORDER BY source_id,revision",
    [ids],
    10000,
  );
  const jobs = await bounded(
    db,
    `SELECT DISTINCT ON (r.detail->>'annotationId',r.detail->>'revision')
    r.detail->>'annotationId' AS annotation_id,(r.detail->>'revision')::integer AS annotation_revision,
    j.source_revisions,j.source_generations,j.correction_generations,j.status
    FROM pilot_knowledge_receipts r JOIN pilot_knowledge_jobs j ON j.id=r.detail->>'workId'
    WHERE r.kind='annotation-committed' ORDER BY r.detail->>'annotationId',r.detail->>'revision',r.id DESC`,
    [],
  );
  const corrections = await bounded(
    db,
    "SELECT id,source_id,source_revision,status,affected_annotation_ids,review_origin,review_note,resolution_annotation_id,created_at,resolved_at FROM pilot_knowledge_corrections ORDER BY created_at",
    [],
  );
  const manifests = await bounded(
    db,
    "SELECT id,generation,manifest,created_at FROM pilot_knowledge_manifests ORDER BY created_at",
    [],
    1000,
  );
  // Completion is committed only after the revision-checked memory write succeeds.
  // Unchanged-memory reviews create no new memory commit, so require the done episode/work pair.
  // learned=true is deliberately never consulted: a cached admission flag is not a review receipt.
  const reviewed = (
    await db.query(`SELECT DISTINCT unnest(e.read_ids) AS id
    FROM pilot_history_episodes e JOIN pilot_work w ON w.id=e.work_id AND w.history_episode=e.id AND w.status='done'
    WHERE e.status='done' LIMIT 50001`)
  ).rows.map((row) => row.id);
  const context = (
    await db.query(`SELECT DISTINCT unnest(e.context_ids) AS id
    FROM pilot_history_episodes e JOIN pilot_work w ON w.id=e.work_id AND w.history_episode=e.id AND w.status='done'
    WHERE e.status='done' LIMIT 50001`)
  ).rows.map((row) => row.id);
  const deferred = (
    await db.query(
      "SELECT DISTINCT jsonb_array_elements_text(manifest->'sourceIds') AS id FROM pilot_history_episodes WHERE status='deferred' LIMIT 50001",
    )
  ).rows.map((row) => row.id);
  if (reviewed.length + context.length + deferred.length > 50000)
    throw new Error("History census exceeds its bounded ID limit");
  const episodes = (
    await db.query(
      "SELECT status,count(*)::integer AS count FROM pilot_history_episodes GROUP BY status ORDER BY status",
    )
  ).rows;
  const cache = (
    await db.query(`SELECT count(*)::integer AS stored,count(*) FILTER (WHERE NOT deleted)::integer AS nondeleted,
    min(source->>'createdAt') AS first,max(source->>'createdAt') AS last FROM pilot_sources`)
  ).rows[0];
  const memory = (await db.query("SELECT count(*)::integer AS entries FROM pilot_memory_entries"))
    .rows[0];
  const represented = [
    ...new Set(
      annotations
        .filter((row) => row.status === "candidate")
        .flatMap((row) => row.candidate.sourceIds ?? []),
    ),
  ];
  const selected = [
    ...new Set(
      manifests.flatMap((row) =>
        (row.manifest.episodes ?? []).flatMap((episode) => [
          ...(episode.sourceIds ?? []),
          ...(episode.contextIds ?? []),
        ]),
      ),
    ),
  ];
  return {
    graph: buildGraph({ annotations, sources, revisions, jobs, corrections, manifests }),
    stages: { reviewed, context, represented, selected, deferred },
    pilot: {
      episodes,
      cache,
      memory,
      currentCandidates: annotations.filter((row) => row.status === "candidate").length,
      annotationVersions: annotations.length,
    },
  };
}

export async function readArchive(db, stages) {
  const params = [
    stages.reviewed,
    stages.context,
    stages.represented,
    stages.selected,
    stages.deferred,
  ];
  const rows = (
    await db.query(
      `SELECT guild_id,channel_id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM') AS month,
    count(*)::integer AS stored,
    count(*) FILTER (WHERE deleted_at IS NULL AND content IS NOT NULL AND btrim(content)<>'' AND thread_id IS NULL)::integer AS usable,
    count(*) FILTER (WHERE thread_id IS NOT NULL)::integer AS thread_rows,
    count(*) FILTER (WHERE message_id=ANY($1::text[]))::integer AS reviewed,
    count(*) FILTER (WHERE message_id=ANY($2::text[]))::integer AS context,
    count(*) FILTER (WHERE message_id=ANY($3::text[]))::integer AS represented,
    count(*) FILTER (WHERE message_id=ANY($4::text[]))::integer AS selected,
    count(*) FILTER (WHERE message_id=ANY($5::text[]))::integer AS deferred,
    count(*) FILTER (WHERE deleted_at IS NULL AND content IS NOT NULL AND btrim(content)<>'' AND thread_id IS NULL AND NOT(message_id=ANY($1::text[])))::integer AS without_review_receipt,
    min(created_at) AS first,max(created_at) AS last
    FROM messages GROUP BY guild_id,channel_id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM') ORDER BY guild_id,channel_id,month LIMIT 10001`,
      params,
    )
  ).rows;
  if (rows.length > 10000)
    throw new Error("Archive census exceeds its bounded channel/month limit");
  const total = rows.reduce(
    (sum, row) => {
      for (const field of [
        "stored",
        "usable",
        "thread_rows",
        "reviewed",
        "context",
        "represented",
        "selected",
        "deferred",
        "without_review_receipt",
      ])
        sum[field] = (sum[field] ?? 0) + row[field];
      return sum;
    },
    Object.fromEntries(
      [
        "stored",
        "usable",
        "thread_rows",
        "reviewed",
        "context",
        "represented",
        "selected",
        "deferred",
        "without_review_receipt",
      ].map((field) => [field, 0]),
    ),
  );
  return {
    status: "available",
    rows,
    total,
    inventory: "unknown",
    checkpointAccess: "not inspected",
    note: "Counts describe this archive, not the entire Discord server. Accessible channel/thread inventory and backfill checkpoints have not been reconciled. Archive and pilot snapshots are separate database transactions. Reviewed means a historical committed receipt; later edits/deletions may need re-review. Stages overlap and must not be added together.",
  };
}

export async function loadSnapshot(directory) {
  const pilot = await readOnly(await readConfig(directory, "postgres.json"), readPilot);
  let archive;
  try {
    archive = await readOnly(await readConfig(directory, "history-postgres.json"), (db) =>
      readArchive(db, pilot.stages),
    );
  } catch {
    archive = {
      status: "unavailable",
      inventory: "unknown",
      rows: [],
      total: null,
      note: "Archive census unavailable. Check the private connection and SELECT permissions locally. No zero counts or server-completeness claim can be inferred.",
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: "live PostgreSQL snapshot",
    graph: pilot.graph,
    coverage: {
      archive,
      pilot: pilot.pilot,
      stages: Object.fromEntries(
        Object.entries(pilot.stages).map(([stage, ids]) => [stage, ids.length]),
      ),
    },
  };
}
