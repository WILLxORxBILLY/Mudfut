import { safeError } from "./runtime.mjs";
import { digest } from "./pilot-store.mjs";

export const historyFailureSchema = `
  ALTER TABLE pilot_history_episodes ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0;
  ALTER TABLE pilot_history_episodes ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
  CREATE TABLE IF NOT EXISTS pilot_history_failures (
    id bigserial PRIMARY KEY, episode_id text NOT NULL REFERENCES pilot_history_episodes(id),
    attempt_no integer NOT NULL, retry_index integer NOT NULL, epoch integer NOT NULL,
    phase text NOT NULL, classification text NOT NULL, detail jsonb NOT NULL,
    outcome text NOT NULL, next_attempt_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(episode_id,attempt_no));
  CREATE TABLE IF NOT EXISTS pilot_history_admission_failures (
    fingerprint text PRIMARY KEY, path text NOT NULL, content_sha256 text NOT NULL,
    detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE OR REPLACE FUNCTION pilot_history_failure_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Historical failure audit is append-only'; END $$;
  DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pilot_history_failures_immutable' AND tgrelid='pilot_history_failures'::regclass) THEN
      CREATE TRIGGER pilot_history_failures_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON pilot_history_failures FOR EACH STATEMENT EXECUTE FUNCTION pilot_history_failure_append_only();
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pilot_history_admission_failures_immutable' AND tgrelid='pilot_history_admission_failures'::regclass) THEN
      CREATE TRIGGER pilot_history_admission_failures_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON pilot_history_admission_failures FOR EACH STATEMENT EXECUTE FUNCTION pilot_history_failure_append_only();
    END IF;
  END $$;
`;

export function historicalFailureClass(error, { stopping = false, phase } = {}) {
  if (stopping) return "shutdown";
  if (["HISTORY_PREEMPTED", "HISTORY_QUEUE_YIELD"].includes(error?.code)) return "preempted";
  let cause = error;
  for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause) {
    const status = cause.status ?? cause.statusCode;
    if (status === 403 && [50001, 50013].includes(Number(cause.code))) return "source_access";
    const message = safeError(cause);
    if (
      [401, 403, 408, 429].includes(status) ||
      status >= 500 ||
      /^(?:[0-9A-Z]{5}|EACCES|ENOSPC|EROFS|EMFILE|ENOENT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(
        cause.code ?? "",
      ) ||
      /invalid.grant|unauthorized|forbidden|invalid.*credential|refresh.token|fetch failed|socket|connection (?:terminated|closed)|PostgreSQL memory|checksum mismatch|Invalid structured understanding|Legacy memory needs/i.test(
        message,
      )
    )
      return "infrastructure";
  }
  return "episode";
}

export function historicalCandidateFailure(error) {
  if (
    ["HISTORY_CANDIDATE_INVALID", "22P02", "23502", "23514", "22001", "22003", "22023"].includes(
      error?.code,
    )
  )
    return true;
  return (
    error?.name === "SyntaxError" ||
    /^(?:Expected version 2 understanding|Memory evidence and source lineage must be arrays|Invalid memory (?:source lineage|work identity))/.test(
      safeError(error),
    ) ||
    /^(?:Invalid (?:prepared memory candidate|structured understanding|understanding|memory (?:entry|update|revision|patch))|PostgreSQL memory requires structured)/i.test(
      safeError(error),
    )
  );
}

function diagnostic(error, depth = 0) {
  if (!error || depth > 3) return undefined;
  return {
    name: error.name ?? "Error",
    message: safeError(error),
    code: error.code ?? null,
    status: error.status ?? error.statusCode ?? null,
    cause: error.cause === error ? undefined : diagnostic(error.cause, depth + 1),
  };
}

export function historyFailures(store, record = async () => {}, { now = Date.now } = {}) {
  const transaction =
    store.transaction ??
    (async (action) => {
      await store.db.query("BEGIN");
      try {
        const value = await action();
        await store.db.query("COMMIT");
        return value;
      } catch (error) {
        await store.db.query("ROLLBACK");
        throw error;
      }
    });
  let initialized = false;
  const ready = async () => {
    if (!initialized) {
      await store.db.query(historyFailureSchema);
      initialized = true;
    }
  };
  return {
    ready,
    async fail(episodeId, error, { phase, stopping = false } = {}) {
      await ready();
      const classification = historicalFailureClass(error, { phase, stopping });
      if (["preempted", "shutdown", "infrastructure"].includes(classification)) return null;
      const receipt = await transaction(async () => {
        const episode = (
          await store.db.query("SELECT * FROM pilot_history_episodes WHERE id=$1 FOR UPDATE", [
            episodeId,
          ])
        ).rows[0];
        if (!episode || !["queued", "retry"].includes(episode.status)) return null;
        if (
          (
            await store.db.query(
              "SELECT 1 FROM pilot_work WHERE history_episode=$1 AND status='prepared' LIMIT 1",
              [episodeId],
            )
          ).rowCount
        )
          return null;
        const retryIndex = episode.failure_count + 1;
        const attemptNo = Number(
          (
            await store.db.query(
              "SELECT COALESCE(max(attempt_no),0)+1 AS n FROM pilot_history_failures WHERE episode_id=$1",
              [episodeId],
            )
          ).rows[0].n,
        );
        const outcome = retryIndex >= 3 ? "deferred" : "retry";
        const nextAttemptAt =
          outcome === "deferred"
            ? null
            : new Date(now() + [30000, 120000][retryIndex - 1]).toISOString();
        const epoch = (await store.meta()).epoch;
        await store.db.query(
          `INSERT INTO pilot_history_failures(episode_id,attempt_no,retry_index,epoch,phase,classification,detail,outcome,next_attempt_at)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
          [
            episodeId,
            attemptNo,
            retryIndex,
            epoch,
            phase,
            classification,
            JSON.stringify(diagnostic(error)),
            outcome,
            nextAttemptAt,
          ],
        );
        await store.db.query(
          "UPDATE pilot_history_episodes SET failure_count=$2,status=$3,next_attempt_at=$4 WHERE id=$1",
          [episodeId, retryIndex, outcome, nextAttemptAt],
        );
        return {
          episodeId,
          attemptNo,
          retryIndex,
          classification,
          status: outcome,
          nextAttemptAt,
          phase,
          error: safeError(error),
          reviewed: false,
        };
      });
      if (receipt) await record({ type: "history_episode_failure", ...receipt });
      return receipt;
    },
    async defer(episodeId, reason) {
      if (
        typeof episodeId !== "string" ||
        !episodeId ||
        typeof reason !== "string" ||
        !reason.trim() ||
        reason.length > 800
      )
        throw new Error("Historical operator deferral requires an episode ID and bounded reason");
      await ready();
      const receipt = await transaction(async () => {
        const episode = (
          await store.db.query("SELECT * FROM pilot_history_episodes WHERE id=$1 FOR UPDATE", [
            episodeId,
          ])
        ).rows[0];
        if (!episode) throw new Error("Unknown historical episode");
        if (episode.status === "deferred") return { episodeId, status: "already-deferred" };
        if (!["queued", "retry"].includes(episode.status))
          throw new Error("Only queued or retrying historical episodes can be operator-deferred");
        if (
          (
            await store.db.query(
              "SELECT 1 FROM pilot_work WHERE history_episode=$1 AND status='prepared' LIMIT 1",
              [episodeId],
            )
          ).rowCount
        )
          throw new Error(
            "A prepared historical memory candidate must be recovered before deferral",
          );
        const attemptNo = Number(
          (
            await store.db.query(
              "SELECT COALESCE(max(attempt_no),0)+1 AS n FROM pilot_history_failures WHERE episode_id=$1",
              [episodeId],
            )
          ).rows[0].n,
        );
        const epoch = (await store.meta()).epoch;
        await store.db.query(
          `INSERT INTO pilot_history_failures(episode_id,attempt_no,retry_index,epoch,phase,classification,detail,outcome,next_attempt_at)
          VALUES($1,$2,$3,$4,'operator_hold','operator_scope',$5::jsonb,'deferred',NULL)`,
          [
            episodeId,
            attemptNo,
            episode.failure_count,
            epoch,
            JSON.stringify({ reason: reason.trim() }),
          ],
        );
        await store.db.query(
          "UPDATE pilot_history_episodes SET status='deferred',next_attempt_at=NULL WHERE id=$1",
          [episodeId],
        );
        return { episodeId, attemptNo, status: "deferred", reason: reason.trim() };
      });
      if (receipt.status === "deferred")
        await record({ type: "history_episode_operator_deferred", ...receipt });
      return receipt;
    },
    async resume(episodeId, reason) {
      if (
        typeof episodeId !== "string" ||
        !episodeId ||
        typeof reason !== "string" ||
        !reason.trim() ||
        reason.length > 800
      )
        throw new Error("Historical operator resumption requires an episode ID and bounded reason");
      await ready();
      const receipt = await transaction(async () => {
        const episode = (
          await store.db.query("SELECT * FROM pilot_history_episodes WHERE id=$1 FOR UPDATE", [
            episodeId,
          ])
        ).rows[0];
        if (!episode) throw new Error("Unknown historical episode");
        if (episode.status !== "deferred")
          throw new Error("Only operator-deferred historical episodes can be resumed");
        if (episode.work_id || episode.read_ids?.length)
          throw new Error(
            "A historical episode with committed work or read receipts cannot be resumed",
          );
        const previous = (
          await store.db.query(
            "SELECT attempt_no,phase,classification,outcome FROM pilot_history_failures WHERE episode_id=$1 ORDER BY attempt_no DESC LIMIT 1",
            [episodeId],
          )
        ).rows[0];
        if (
          previous?.phase !== "operator_hold" ||
          previous.classification !== "operator_scope" ||
          previous.outcome !== "deferred"
        )
          throw new Error("Only an audited operator-scope hold can be resumed");
        if (
          (
            await store.db.query("SELECT 1 FROM pilot_work WHERE history_episode=$1 LIMIT 1", [
              episodeId,
            ])
          ).rowCount
        )
          throw new Error("Historical work already exists; recover or review it before resumption");
        const attemptNo = Number(
          (
            await store.db.query(
              "SELECT COALESCE(max(attempt_no),0)+1 AS n FROM pilot_history_failures WHERE episode_id=$1",
              [episodeId],
            )
          ).rows[0].n,
        );
        const epoch = (await store.meta()).epoch;
        await store.db.query(
          `INSERT INTO pilot_history_failures(episode_id,attempt_no,retry_index,epoch,phase,classification,detail,outcome,next_attempt_at)
          VALUES($1,$2,$3,$4,'operator_resume','operator_scope',$5::jsonb,'resumed',NULL)`,
          [
            episodeId,
            attemptNo,
            episode.failure_count,
            epoch,
            JSON.stringify({ reason: reason.trim(), resumedAfterAttempt: previous.attempt_no }),
          ],
        );
        await store.db.query(
          "UPDATE pilot_history_episodes SET status='queued',next_attempt_at=NULL WHERE id=$1",
          [episodeId],
        );
        return { episodeId, attemptNo, status: "queued", reason: reason.trim() };
      });
      await record({ type: "history_episode_operator_resumed", ...receipt });
      return receipt;
    },
    async deferCandidate(work, error, proof) {
      await ready();
      if (
        !work.history_episode ||
        !proof ||
        (!proof.landed &&
          (!historicalCandidateFailure(error) ||
            proof.currentRevision !== work.candidate.expectedRevision))
      )
        return null;
      const receipt = await transaction(async () => {
        const saved = (
          await store.db.query("SELECT * FROM pilot_work WHERE id=$1 FOR UPDATE", [work.id])
        ).rows[0];
        if (!saved || saved.status !== "prepared" || saved.history_episode !== work.history_episode)
          return null;
        // Lock the authoritative PG revision while deciding whether an uncommitted candidate may be quarantined.
        const memory = (
          await store.db.query("SELECT revision FROM pilot_memory_meta WHERE id FOR UPDATE")
        ).rows[0];
        const candidateRevision =
          typeof saved.candidate.content === "string" ? digest(saved.candidate.content) : null;
        const landed = candidateRevision !== null && memory?.revision === candidateRevision;
        if (
          !landed &&
          (memory?.revision !== saved.candidate.expectedRevision ||
            !historicalCandidateFailure(error))
        )
          return null;
        const episode = (
          await store.db.query("SELECT * FROM pilot_history_episodes WHERE id=$1 FOR UPDATE", [
            work.history_episode,
          ])
        ).rows[0];
        if (!episode) return null;
        const attemptNo = Number(
          (
            await store.db.query(
              "SELECT COALESCE(max(attempt_no),0)+1 AS n FROM pilot_history_failures WHERE episode_id=$1",
              [episode.id],
            )
          ).rows[0].n,
        );
        const outcome = landed ? "committed-recovery" : "deferred-candidate";
        await store.db.query(
          `INSERT INTO pilot_history_failures(episode_id,attempt_no,retry_index,epoch,phase,classification,detail,outcome)
          VALUES($1,$2,$3,$4,'memory_commit','candidate',$5::jsonb,$6)`,
          [
            episode.id,
            attemptNo,
            episode.failure_count,
            work.epoch,
            JSON.stringify({
              ...diagnostic(error),
              workId: work.id,
              parentRevision: saved.candidate.expectedRevision,
              candidateRevision,
              currentRevision: memory.revision,
              writeLanded: landed,
            }),
            outcome,
          ],
        );
        if (!landed) {
          await store.db.query("UPDATE pilot_work SET status='deferred' WHERE id=$1", [work.id]);
          await store.db.query(
            "UPDATE pilot_history_episodes SET status='deferred',next_attempt_at=NULL WHERE id=$1",
            [episode.id],
          );
        }
        return {
          episodeId: episode.id,
          workId: work.id,
          status: outcome,
          action: landed ? "reconcile" : "deferred",
          error: safeError(error),
          modelReplay: false,
        };
      });
      if (receipt) await record({ type: "history_candidate_failure", ...receipt });
      return receipt?.action ?? null;
    },
    async rejected(path, content) {
      await ready();
      const fingerprint = digest(path + "\n" + content);
      return Boolean(
        (
          await store.db.query(
            "SELECT 1 FROM pilot_history_admission_failures WHERE fingerprint=$1",
            [fingerprint],
          )
        ).rowCount,
      );
    },
    async reject(path, content, error) {
      await ready();
      if (historicalFailureClass(error) === "infrastructure") throw error;
      const sha = digest(content),
        fingerprint = digest(path + "\n" + content);
      const inserted = await store.db.query(
        `INSERT INTO pilot_history_admission_failures(fingerprint,path,content_sha256,detail)
        VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING fingerprint`,
        [fingerprint, path, sha, JSON.stringify(diagnostic(error))],
      );
      if (inserted.rowCount)
        await record({
          type: "history_admission_deferred",
          path,
          contentSha256: sha,
          error: safeError(error),
          reviewed: false,
        });
    },
  };
}
