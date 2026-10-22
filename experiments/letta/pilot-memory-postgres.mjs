import { digest } from "./pilot-store.mjs";
import { decodeUnderstanding, encodeUnderstanding } from "./pilot-memory.mjs";

function entriesFrom(content) {
  if (typeof content !== "string") throw new Error("Expected version 2 understanding text");
  const entries = decodeUnderstanding(content);
  if (
    !entries ||
    entries.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.key !== "string" ||
        !entry.key.length,
    ) ||
    new Set(entries.map((entry) => entry.key)).size !== entries.length
  )
    throw new Error("Expected version 2 understanding with unique entry keys");
  return entries;
}

function sourceIds(entry) {
  if (
    !Array.isArray(entry.evidence ?? []) ||
    !Array.isArray(entry.sourceIds ?? []) ||
    !Array.isArray(entry.lineage?.sourceIds ?? [])
  )
    throw new Error("Memory evidence and source lineage must be arrays");
  const ids = [
    ...(entry.evidence ?? []).map((item) => item.messageId),
    ...(entry.sourceIds ?? []),
    ...(entry.lineage?.sourceIds ?? []),
  ];
  if (ids.some((id) => typeof id !== "string" || !id.length))
    throw new Error("Invalid memory source lineage");
  return [...new Set(ids)];
}

const schema = `
  CREATE TABLE IF NOT EXISTS pilot_memory_commits (
    id bigserial PRIMARY KEY, revision text NOT NULL, parent_revision text,
    parent_commit_id bigint REFERENCES pilot_memory_commits(id), agent_id text NOT NULL,
    work_id text, audit jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS pilot_memory_meta (
    id boolean PRIMARY KEY DEFAULT true CHECK(id), agent_id text NOT NULL,
    content text NOT NULL, revision text NOT NULL,
    commit_id bigint NOT NULL REFERENCES pilot_memory_commits(id));
  CREATE TABLE IF NOT EXISTS pilot_memory_migrations (
    id boolean PRIMARY KEY DEFAULT true CHECK(id), agent_id text NOT NULL,
    content text NOT NULL, revision text NOT NULL, entry_count integer NOT NULL,
    commit_id bigint NOT NULL REFERENCES pilot_memory_commits(id),
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS pilot_memory_versions (
    id bigserial PRIMARY KEY, key text NOT NULL,
    commit_id bigint NOT NULL REFERENCES pilot_memory_commits(id),
    previous_version_id bigint REFERENCES pilot_memory_versions(id),
    entry_text text, entry jsonb, source_ids text[] NOT NULL,
    tombstone boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((tombstone AND entry IS NULL AND entry_text IS NULL) OR
      (NOT tombstone AND entry IS NOT NULL AND entry_text IS NOT NULL)));
  CREATE TABLE IF NOT EXISTS pilot_memory_entries (
    key text PRIMARY KEY, version_id bigint NOT NULL REFERENCES pilot_memory_versions(id));
  CREATE INDEX IF NOT EXISTS pilot_memory_versions_key ON pilot_memory_versions(key,id DESC);
  CREATE INDEX IF NOT EXISTS pilot_memory_versions_sources ON pilot_memory_versions USING gin(source_ids);
  CREATE OR REPLACE FUNCTION pilot_memory_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Memory history is append-only'; END $$;
  DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pilot_memory_commits_immutable' AND tgrelid='pilot_memory_commits'::regclass) THEN
      CREATE TRIGGER pilot_memory_commits_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON pilot_memory_commits FOR EACH STATEMENT EXECUTE FUNCTION pilot_memory_append_only();
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pilot_memory_versions_immutable' AND tgrelid='pilot_memory_versions'::regclass) THEN
      CREATE TRIGGER pilot_memory_versions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON pilot_memory_versions FOR EACH STATEMENT EXECUTE FUNCTION pilot_memory_append_only();
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pilot_memory_migrations_immutable' AND tgrelid='pilot_memory_migrations'::regclass) THEN
      CREATE TRIGGER pilot_memory_migrations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON pilot_memory_migrations FOR EACH STATEMENT EXECUTE FUNCTION pilot_memory_append_only();
    END IF;
  END $$;
`;

export async function postgresUnderstanding(db, legacy, { agentId, record = async () => {} } = {}) {
  if (typeof agentId !== "string" || !agentId.trim() || agentId.length > 200)
    throw new Error("PostgreSQL memory requires the existing agent identity");
  const state = async (lock = false) => {
    const row = (
      await db.query(`SELECT * FROM pilot_memory_meta WHERE id${lock ? " FOR UPDATE" : ""}`)
    ).rows[0];
    if (!row || row.agent_id !== agentId)
      throw new Error("PostgreSQL memory agent identity differs");
    if (digest(row.content) !== row.revision)
      throw new Error("PostgreSQL memory checksum mismatch");
    entriesFrom(row.content);
    return row;
  };
  const insertVersion = async (key, entry, previous, commitId, retainedSourceIds) => {
    const text = entry === null ? null : JSON.stringify(entry);
    const row = (
      await db.query(
        `INSERT INTO pilot_memory_versions
      (key,commit_id,previous_version_id,entry_text,entry,source_ids,tombstone)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [key, commitId, previous ?? null, text, text, retainedSourceIds, entry === null],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO pilot_memory_entries(key,version_id) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET version_id=excluded.version_id`,
      [key, row.id],
    );
  };
  let migrationReceipt;
  await db.query("BEGIN");
  try {
    // The migration lock is independent of the running pilot's source/work lock.
    await db.query("SELECT pg_advisory_xact_lock(1560387,1127030)");
    await db.query(schema);
    let current = (await db.query("SELECT * FROM pilot_memory_meta WHERE id FOR UPDATE")).rows[0];
    if (!current) {
      const imported = await legacy.read();
      const entries = entriesFrom(imported.content);
      if (digest(imported.content) !== imported.revision)
        throw new Error("Legacy memory checksum mismatch");
      const commit = (
        await db.query(
          `INSERT INTO pilot_memory_commits(revision,agent_id,audit)
        VALUES($1,$2,$3) RETURNING id`,
          [
            imported.revision,
            agentId,
            JSON.stringify({ kind: "lossless_legacy_migration", entryCount: entries.length }),
          ],
        )
      ).rows[0];
      for (const entry of entries)
        await insertVersion(entry.key, entry, null, commit.id, sourceIds(entry));
      await db.query(
        "INSERT INTO pilot_memory_meta(id,agent_id,content,revision,commit_id) VALUES(true,$1,$2,$3,$4)",
        [agentId, imported.content, imported.revision, commit.id],
      );
      await db.query(
        `INSERT INTO pilot_memory_migrations(id,agent_id,content,revision,entry_count,commit_id)
        VALUES(true,$1,$2,$3,$4,$5)`,
        [agentId, imported.content, imported.revision, entries.length, commit.id],
      );
      current = await state();
      const saved = (await db.query("SELECT count(*)::integer AS count FROM pilot_memory_entries"))
        .rows[0];
      if (
        current.content !== imported.content ||
        current.revision !== imported.revision ||
        saved.count !== entries.length
      )
        throw new Error("Lossless PostgreSQL memory migration verification failed");
      await record({
        type: "memory_migrated",
        agentId,
        revision: imported.revision,
        entries: entries.length,
        commitId: commit.id,
      });
    } else await state();
    const receipt = (
      await db.query(
        "SELECT agent_id,revision,entry_count,commit_id,created_at FROM pilot_memory_migrations WHERE id",
      )
    ).rows[0];
    if (!receipt || receipt.agent_id !== agentId)
      throw new Error("Missing PostgreSQL memory migration receipt");
    migrationReceipt = {
      agentId: receipt.agent_id,
      revision: receipt.revision,
      entryCount: receipt.entry_count,
      commitId: receipt.commit_id,
      createdAt: receipt.created_at.toISOString(),
    };
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }

  // One client serializes transactions; independent clients lock the singleton.
  // ponytail: the legacy text contract still materializes O(n) current memory;
  // indexed per-key recall/patch writes are the upgrade when materialization
  // becomes expensive. History stores changed entries without lifetime caps.
  let pending = Promise.resolve();
  const serialized = (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const view = (row) => ({ content: row.content, revision: row.revision });
  async function mutate(build) {
    await db.query("BEGIN");
    try {
      const previous = await state(true);
      const input = await build(previous);
      if (
        !input ||
        typeof input.content !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.expectedRevision ?? "")
      )
        throw new Error("Invalid PostgreSQL memory update");
      const entries = entriesFrom(input.content);
      const revision = digest(input.content);
      // Recovery can repeat a committed candidate with its original parent SHA.
      if (input.content === previous.content) {
        await db.query("COMMIT");
        return { ...view(previous), storage: "PostgreSQL", commit: previous.commit_id };
      }
      if (input.expectedRevision !== previous.revision)
        throw new Error("Memory changed; read it again before revising");
      if (input.workId != null && (typeof input.workId !== "string" || input.workId.length > 200))
        throw new Error("Invalid memory work identity");
      const commit = (
        await db.query(
          `INSERT INTO pilot_memory_commits
        (revision,parent_revision,parent_commit_id,agent_id,work_id,audit) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            revision,
            previous.revision,
            previous.commit_id,
            agentId,
            input.workId ?? null,
            JSON.stringify(input.audit ?? {}),
          ],
        )
      ).rows[0];
      const oldRows = (
        await db.query(`SELECT p.key,v.id,v.entry_text,v.source_ids,v.tombstone
        FROM pilot_memory_entries p JOIN pilot_memory_versions v ON v.id=p.version_id`)
      ).rows;
      const old = new Map(oldRows.map((entry) => [entry.key, entry]));
      const newKeys = new Set();
      for (const entry of entries) {
        newKeys.add(entry.key);
        const prior = old.get(entry.key);
        const ids = sourceIds(entry);
        if (!prior || prior.tombstone || prior.entry_text !== JSON.stringify(entry))
          await insertVersion(entry.key, entry, prior?.id, commit.id, ids);
      }
      for (const prior of oldRows)
        if (!prior.tombstone && !newKeys.has(prior.key))
          await insertVersion(prior.key, null, prior.id, commit.id, prior.source_ids);
      await db.query("UPDATE pilot_memory_meta SET content=$1,revision=$2,commit_id=$3 WHERE id", [
        input.content,
        revision,
        commit.id,
      ]);
      const saved = await state();
      if (saved.content !== input.content)
        throw new Error("PostgreSQL memory write verification failed");
      await record({
        type: "memory_revision",
        agentId,
        revision,
        parentRevision: previous.revision,
        commitId: commit.id,
        workId: input.workId ?? null,
        entryCount: entries.length,
      });
      await db.query("COMMIT");
      return { ...view(saved), storage: "PostgreSQL", commit: commit.id };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }
  const affectedEntries = (content, ids) => {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
      throw new Error("Invalid source invalidation IDs");
    return entriesFrom(content).filter((entry) => sourceIds(entry).some((id) => ids.includes(id)));
  };
  return {
    migrationReceipt,
    read: () => serialized(async () => view(await state())),
    write: (input, metadata = {}) => serialized(() => mutate(() => ({ ...metadata, ...input }))),
    legacy: () => legacy.legacy(),
    affected: (ids) =>
      serialized(async () => [
        ...new Set(affectedEntries((await state()).content, ids).flatMap(sourceIds)),
      ]),
    invalidate: (ids) =>
      serialized(async () => {
        let affected = [];
        await mutate((previous) => {
          const removed = affectedEntries(previous.content, ids);
          affected = [...new Set(removed.flatMap(sourceIds))];
          const keys = new Set(removed.map((entry) => entry.key));
          return {
            content: removed.length
              ? encodeUnderstanding(
                  entriesFrom(previous.content).filter((entry) => !keys.has(entry.key)),
                )
              : previous.content,
            expectedRevision: previous.revision,
            audit: { kind: "source_invalidation", sourceIds: ids, removedKeys: [...keys] },
          };
        });
        return affected;
      }),
    versions: ({ key, limit = 8 }) =>
      serialized(async () => {
        if (
          typeof key !== "string" ||
          !key.length ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          throw new Error("Invalid memory version query");
        await state();
        return (
          await db.query(
            `SELECT v.*,c.revision,c.parent_revision,c.work_id,c.audit,
        v.id=(SELECT version_id FROM pilot_memory_entries WHERE key=v.key) AS is_current
        FROM pilot_memory_versions v JOIN pilot_memory_commits c ON c.id=v.commit_id
        WHERE v.key=$1 ORDER BY v.id DESC LIMIT $2`,
            [key, limit],
          )
        ).rows;
      }),
  };
}
