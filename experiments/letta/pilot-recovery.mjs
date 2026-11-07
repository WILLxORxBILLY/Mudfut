// One database-owned recovery policy. Only an absent table means ordinary mode;
// an empty, malformed or unreadable policy is never permission to run.
const snowflake = (s) => typeof s === "string" && /^\d{17,20}$/.test(s);
const fail = (detail) =>
  Object.assign(new Error(`Recovery gate: ${detail}`), { code: "PILOT_RECOVERY_GATE" });
const reason = (s) => typeof s === "string" && Boolean(s.trim()) && s.length <= 2000;
export function validateRecoveryPolicy(p) {
  if (
    !p ||
    Object.keys(p).some(
      (key) =>
        ![
          "version",
          "phase",
          "revision",
          "baseline",
          "protectedSourceIds",
          "frontiers",
          "reason",
        ].includes(key),
    ) ||
    p.version !== 1 ||
    !["held", "live-only"].includes(p.phase) ||
    !Number.isSafeInteger(p.revision) ||
    p.revision < 1 ||
    !/^[a-f0-9]{64}$/.test(p.baseline) ||
    !reason(p.reason) ||
    !Array.isArray(p.protectedSourceIds) ||
    p.protectedSourceIds.some((id) => !snowflake(id)) ||
    new Set(p.protectedSourceIds).size !== p.protectedSourceIds.length ||
    !p.frontiers ||
    typeof p.frontiers !== "object" ||
    Array.isArray(p.frontiers) ||
    Object.entries(p.frontiers).some(([channel, id]) => !snowflake(channel) || !snowflake(id)) ||
    (p.phase === "live-only" && !Object.keys(p.frontiers).length)
  )
    throw fail("invalid persistent policy");
  return p;
}
export async function readRecoveryPolicy(db) {
  const exists = (await db.query("SELECT to_regclass('pilot_recovery_policy') AS name")).rows[0]
    ?.name;
  if (!exists) return null;
  const rows = (await db.query("SELECT policy FROM pilot_recovery_policy")).rows;
  if (rows.length !== 1) throw fail("persistent policy must have exactly one row");
  return validateRecoveryPolicy(rows[0].policy);
}
export async function ownsPilot(db) {
  return Boolean(
    (
      await db.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
    AND pid=pg_backend_pid() AND classid=1560387 AND objid=1127029 AND objsubid=2 AND granted) AS owned`)
    ).rows[0]?.owned,
  );
}
export async function claimPilotOwnership(db) {
  if (await ownsPilot(db)) return;
  if (
    !(await db.query("SELECT pg_try_advisory_lock(1560387,1127029) AS acquired")).rows[0]?.acquired
  )
    throw new Error("Another pilot worker owns this database");
}
export function recoverySourceAllowed(policy, source) {
  if (!policy) return true;
  const frontier = policy.frontiers[source?.channelId];
  return (
    policy.phase === "live-only" &&
    snowflake(source?.id) &&
    Boolean(frontier) &&
    !policy.protectedSourceIds.includes(source.id) &&
    BigInt(source.id) > BigInt(frontier)
  );
}
// Kinds that stay denied for the whole live-only phase. "archive" is deliberately
// absent: it is a bounded read-only query against the separate archive role that
// neither enrolls historical work nor derives or replays memory, so inspection
// stays possible while every intake/derivation path above remains closed.
export const liveOnlyDeniedKinds = ["history", "operator", "reset", "migrate", "edit", "remove"];
export const archiveReadKind = "archive";
// Whether the worker may hold a read-only archive connection at all, and which
// gate kind the per-call preflight uses. Held keeps the archive unconstructed;
// live-only opens it for the read-only kind only.
export function archiveAccess(policy) {
  if (!policy) return { readable: true, kind: "history" };
  return policy.phase === "live-only"
    ? { readable: true, kind: archiveReadKind }
    : { readable: false, kind: archiveReadKind };
}
// Historical derivation/replay stays disabled for the whole life of any policy,
// live-only included: a readable archive is not permission to derive remembered
// state. Exported so the runtime wiring and its tests share one decision.
export const historyDerivationDisposition = (policy) => (policy ? "recovery-disabled" : null);
export async function assertRecovery(db, kind = "live", source) {
  const policy = await readRecoveryPolicy(db);
  if (!policy) return null;
  if (!(await ownsPilot(db))) throw fail("session ownership required");
  if (policy.phase === "held") throw fail("held; no runtime side effects or external operations");
  if (liveOnlyDeniedKinds.includes(kind))
    throw fail(`${kind} remains disabled in live-only recovery`);
  if (source && !recoverySourceAllowed(policy, source))
    throw fail("source is protected or outside a released live frontier");
  return policy;
}
export async function ownedExternal(db, kind, callback, source) {
  await claimPilotOwnership(db);
  await assertRecovery(db, kind, source);
  return callback();
}
export async function assertStoreRecovery(store, kind = "live", source) {
  // Existing model-free doubles have no policy capability. Every native store
  // supplies this capability, including objects retained across a later hold.
  return store.recovery ? store.recovery(kind, source) : null;
}

export function recoveryEligibilitySql(parameter, alias = "s") {
  return `(${parameter}::jsonb IS NULL OR (${parameter}::jsonb->'frontiers' ? (${alias}.source->>'channelId')
    AND NOT (${parameter}::jsonb->'protectedSourceIds' ? ${alias}.id)
    AND ${alias}.id::numeric>(${parameter}::jsonb->'frontiers'->>(${alias}.source->>'channelId'))::numeric))`;
}

// All real transport calls share this preflight, including callbacks retained by
// typing/acknowledgment or a model tool. A request already in flight is not recalled.
// An exact original may be read for archive recall even when it predates the live
// frontier. This is read-only: sends, reactions, page reads and every ingest or
// derivation path keep the frontier rule, so nothing can be enrolled from it.
export function archiveRecallReadAllowed(policy, channelId, id) {
  return Boolean(
    policy &&
    policy.phase === "live-only" &&
    snowflake(channelId) &&
    snowflake(id) &&
    Boolean(policy.frontiers[channelId]) &&
    !policy.protectedSourceIds.includes(id),
  );
}
export function recoveryTransport(db, transport) {
  return new Proxy(transport, {
    get(target, key) {
      const fn = target[key];
      if (typeof fn !== "function" || key === "serverTime")
        return typeof fn === "function" ? fn.bind(target) : fn;
      return async (...args) => {
        await claimPilotOwnership(db);
        const p = await assertRecovery(db, "live");
        if (p) {
          if (["recent", "around"].includes(key))
            throw fail("historical/default-page reads disabled");
          if (["get", "react", "send"].includes(key)) {
            const id = key === "send" ? args[1]?.message_reference?.message_id : args[1];
            // An exact original may be referenced even when it predates the live
            // frontier, on the same terms as read-only archive recall: the flag
            // itself still requires a live-only policy, a released route, a
            // snowflake id and an unprotected source, so a protected id, an
            // unreleased route or any other phase keeps the strict per-id
            // preflight below and is refused exactly as before. Only the
            // frontier comparison is relaxed, for the parent a live reply cites.
            if (!archiveRecallReadAllowed(p, args[0], id))
              await assertRecovery(db, "live", { channelId: args[0], id });
          } else if (["after", "typing", "channel"].includes(key)) {
            const bound = p.frontiers[args[0]];
            if (
              !bound ||
              (key === "after" && (!snowflake(args[1]) || BigInt(args[1]) < BigInt(bound)))
            )
              throw fail("route/frontier not released");
          }
        }
        return fn.apply(target, args);
      };
    },
  });
}

// Archive recall needs one exact original even when it predates the live frontier.
// This is a separate, read-only surface: only `get` and `serverTime` pass, the
// channel must be a released route and the ID unprotected, and the live transport
// keeps its own stricter preflight. Nothing read here is ingested or derived.
export function recoveryArchiveSource(db, transport) {
  return new Proxy(transport, {
    get(target, key) {
      const fn = target[key];
      if (key === "serverTime") return typeof fn === "function" ? fn.bind(target) : fn;
      if (key !== "get" || typeof fn !== "function") return undefined;
      return async (channelId, id) => {
        await claimPilotOwnership(db);
        const policy = await assertRecovery(db, archiveReadKind);
        if (policy && !archiveRecallReadAllowed(policy, channelId, id))
          throw fail("archive recall is limited to unprotected ids on released routes");
        return fn.call(target, channelId, id);
      };
    },
  });
}

// Read-only archive access passes "archive" explicitly; the default stays the
// stricter historical kind so an unmarked call site cannot widen the gate.
export function recoveryArchive(db, archive, kind = "history") {
  return new Proxy(archive, {
    get(target, key) {
      const fn = target[key];
      return typeof fn !== "function"
        ? fn
        : (...args) => ownedExternal(db, kind, () => fn.apply(target, args));
    },
  });
}

const schema = `CREATE TABLE IF NOT EXISTS pilot_recovery_policy(
  id boolean PRIMARY KEY DEFAULT true CHECK(id),policy jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS pilot_recovery_audit(
  revision integer PRIMARY KEY,policy jsonb NOT NULL,changed_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE OR REPLACE FUNCTION pilot_recovery_immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Recovery gate audit is append-only'; END $$;
DROP TRIGGER IF EXISTS pilot_recovery_audit_immutable ON pilot_recovery_audit;
CREATE TRIGGER pilot_recovery_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON pilot_recovery_audit
FOR EACH STATEMENT EXECUTE FUNCTION pilot_recovery_immutable_audit();
CREATE OR REPLACE FUNCTION pilot_recovery_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb; item jsonb; s jsonb; ids text[]; sid text; bound text;
BEGIN
  SELECT policy INTO p FROM pilot_recovery_policy;
  IF (p IS NOT NULL AND jsonb_typeof(p)='object' AND jsonb_typeof(p->'version')='number' AND p->>'version'='1'
    AND p->>'phase' IN ('held','live-only') AND jsonb_typeof(p->'baseline')='string'
    AND p->>'baseline' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(p->'revision')='number'
    AND CASE WHEN p->>'revision' ~ '^[1-9][0-9]*$' THEN (p->>'revision')::numeric<=9007199254740991 ELSE false END
    AND jsonb_typeof(p->'protectedSourceIds')='array' AND jsonb_typeof(p->'frontiers')='object'
    AND jsonb_typeof(p->'reason')='string' AND length(btrim(p->>'reason'))>0 AND length(p->>'reason')<=2000) IS NOT TRUE THEN
    RAISE EXCEPTION 'Recovery gate invalid persistent policy'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'protectedSourceIds') v WHERE jsonb_typeof(v) IS DISTINCT FROM 'string' OR (v#>>'{}') !~ '^[0-9]{17,20}$')
    OR EXISTS(SELECT 1 FROM jsonb_each(p->'frontiers') f WHERE f.key !~ '^[0-9]{17,20}$' OR jsonb_typeof(f.value) IS DISTINCT FROM 'string' OR (f.value#>>'{}') !~ '^[0-9]{17,20}$')
    OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(p->'protectedSourceIds') v)<>jsonb_array_length(p->'protectedSourceIds')
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('version','phase','revision','baseline','protectedSourceIds','frontiers','reason'))
    OR (p->>'phase'='live-only' AND p->'frontiers'='{}'::jsonb) THEN RAISE EXCEPTION 'Recovery gate invalid persistent policy'; END IF;
  IF p->>'phase'='held' OR TG_TABLE_NAME LIKE 'pilot_history%' OR TG_TABLE_NAME LIKE 'pilot_operator%' THEN
    RAISE EXCEPTION 'Recovery gate prevents protected state mutation'; END IF;
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Recovery gate prevents truncate'; END IF;
  IF TG_TABLE_NAME='pilot_meta' AND TG_OP='UPDATE' THEN
    IF NEW.epoch<>OLD.epoch OR NEW.rebuild IS DISTINCT FROM OLD.rebuild OR NEW.relearning IS DISTINCT FROM OLD.relearning
      OR NEW.invalid_sources IS DISTINCT FROM OLD.invalid_sources OR NEW.memory_version IS DISTINCT FROM OLD.memory_version THEN
      RAISE EXCEPTION 'Recovery gate prevents global invalidation'; END IF;
  END IF;
  IF TG_TABLE_NAME IN ('pilot_sources','pilot_work','pilot_outbox') THEN
    IF TG_OP='UPDATE' THEN
      IF TG_TABLE_NAME='pilot_sources' THEN
        IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Recovery gate prevents source identity rewrite'; END IF;
      ELSIF TG_TABLE_NAME='pilot_outbox' THEN
        IF NEW.source_id IS DISTINCT FROM OLD.source_id THEN RAISE EXCEPTION 'Recovery gate prevents reply identity rewrite'; END IF;
      ELSIF TG_TABLE_NAME='pilot_work' THEN
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.source_ids IS DISTINCT FROM OLD.source_ids
          OR NEW.validation_ids IS DISTINCT FROM OLD.validation_ids OR NEW.history_episode IS DISTINCT FROM OLD.history_episode THEN
          RAISE EXCEPTION 'Recovery gate prevents work identity rewrite'; END IF;
      END IF;
    END IF;
    item:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    IF TG_TABLE_NAME='pilot_sources' THEN
      IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (NEW.source IS DISTINCT FROM OLD.source OR NEW.hash IS DISTINCT FROM OLD.hash)) THEN
        RAISE EXCEPTION 'Recovery gate prevents source revision/removal'; END IF;
      s:=item->'source'; ids:=ARRAY[item->>'id'];
    ELSIF TG_TABLE_NAME='pilot_outbox' THEN ids:=ARRAY[item->>'source_id'];
    ELSE
      IF item->>'history_episode' IS NOT NULL OR (item->'candidate') ? 'operatorRequestId' OR jsonb_array_length(item->'source_ids')=0 THEN
        RAISE EXCEPTION 'Recovery gate prevents historical/operator work'; END IF;
      -- Enrolment is governed by source_ids only. validation_ids are citations a
      -- reply quotes; they are never enrolled, derived or sent, and gating them
      -- refused every reply that cited pre-frontier memory. A citation must still
      -- name a source that exists, but it is not required to be inside the frontier.
      SELECT array_agg(value) INTO ids FROM jsonb_array_elements_text(item->'source_ids');
      FOREACH sid IN ARRAY coalesce(ARRAY(SELECT value FROM jsonb_array_elements_text(coalesce(item->'validation_ids','[]'))),'{}') LOOP
        IF NOT EXISTS(SELECT 1 FROM pilot_sources WHERE id=sid) THEN
          RAISE EXCEPTION 'Recovery gate protects this source'; END IF;
      END LOOP;
    END IF;
    FOREACH sid IN ARRAY ids LOOP
      IF TG_TABLE_NAME<>'pilot_sources' THEN SELECT source INTO s FROM pilot_sources WHERE id=sid; END IF;
      bound:=p->'frontiers'->>(s->>'channelId');
      IF s IS NULL OR bound IS NULL OR (p->'protectedSourceIds') ? sid OR sid::numeric<=bound::numeric THEN
        RAISE EXCEPTION 'Recovery gate protects this source'; END IF;
    END LOOP;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;`;

async function audit(db, p) {
  await db.query("INSERT INTO pilot_recovery_audit(revision,policy) VALUES($1,$2)", [
    p.revision,
    p,
  ]);
}
export async function holdRecovery(db, { baseline, protectedSourceIds, reason: why }) {
  const p = validateRecoveryPolicy({
    version: 1,
    phase: "held",
    revision: 1,
    baseline,
    protectedSourceIds,
    frontiers: {},
    reason: why,
  });
  await claimPilotOwnership(db);
  if (await readRecoveryPolicy(db))
    throw fail("policy already exists; do not replace its baseline");
  await db.query("BEGIN");
  try {
    await db.query(schema);
    await db.query("INSERT INTO pilot_recovery_policy(policy) VALUES($1)", [p]);
    await audit(db, p);
    // Defense in depth for raw/manual memory and queue APIs, not just the store.
    // Privileged DDL/trigger removal is outside this trusted single-writer boundary.
    // ponytail: guards cover existing pilot_* tables in this schema only. New
    // tables require an explicitly qualified guard migration before operational use.
    await db.query(`DO $$ DECLARE t record; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname=current_schema()
        AND tablename LIKE 'pilot\\_%' ESCAPE '\\' AND tablename NOT LIKE 'pilot_recovery%' LOOP
        EXECUTE format('CREATE TRIGGER pilot_recovery_rows BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pilot_recovery_write_guard()',t.tablename);
        EXECUTE format('CREATE TRIGGER pilot_recovery_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION pilot_recovery_write_guard()',t.tablename);
      END LOOP; END $$;`);
    await db.query("COMMIT");
    return p;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
export async function releaseRecovery(
  db,
  { expectedRevision, reason: why, frontiers, confirmLiveOnly },
) {
  if (!reason(why)) throw fail("explicit release reason required");
  if (confirmLiveOnly !== true)
    throw fail("explicit live-only confirmation required; this is not activation");
  if (!frontiers || !Object.keys(frontiers).length)
    throw fail("explicit live route frontiers required");
  await claimPilotOwnership(db);
  await db.query("BEGIN");
  try {
    const current = await readRecoveryPolicy(db);
    if (!current || current.phase !== "held" || current.revision !== expectedRevision)
      throw fail("release revision/phase mismatch");
    const p = validateRecoveryPolicy({
      ...current,
      phase: "live-only",
      revision: current.revision + 1,
      reason: why,
      frontiers,
    });
    const changed = await db.query(
      "UPDATE pilot_recovery_policy SET policy=$1 WHERE (policy->>'revision')::int=$2 RETURNING id",
      [p, expectedRevision],
    );
    if (changed.rowCount !== 1) throw fail("release revision changed");
    await audit(db, p);
    await db.query("COMMIT");
    return p;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
