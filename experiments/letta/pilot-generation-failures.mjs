// Incomplete model output is a work-item failure, never permission to invent decisions.
export const generationFailureLimit = 3;
export function requireObservationDecisions(complete) {
  if (!complete)
    throw Object.assign(
      new Error("Model omitted explicit observation decisions; work remains unlearned"),
      { code: "MODEL_OBSERVATIONS_INCOMPLETE" },
    );
}

function unfinishedLiveTurn({ batch, phase, stopping, connectionFailure }) {
  return Boolean(
    phase === "model" &&
    !stopping &&
    !connectionFailure &&
    batch?.rows?.length &&
    !batch.historyEpisode &&
    !batch.operatorRequest,
  );
}

export function incompleteLiveTurn(error, context) {
  return error?.code === "MODEL_OBSERVATIONS_INCOMPLETE" && unfinishedLiveTurn(context);
}

export function localModelFailure(error) {
  return [
    "MODEL_OBSERVATIONS_INCOMPLETE",
    "MODEL_TURN_DEADLINE",
    "MODEL_TRANSPORT_TIMEOUT",
  ].includes(error?.code);
}

export function normalizeModelFailure(error) {
  if (!error?.code && error?.message === "Timed out waiting for app-server turn")
    error.code = "MODEL_TRANSPORT_TIMEOUT";
  return error;
}

export function recoverableLiveTurn(error, context) {
  return localModelFailure(error) && unfinishedLiveTurn(context);
}

export const generationFailureSchema = `CREATE TABLE IF NOT EXISTS pilot_generation_failures (
  source_id text NOT NULL, source_hash text NOT NULL,
  failure_count integer NOT NULL CHECK(failure_count > 0),
  next_attempt_at timestamptz NOT NULL, last_failed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,source_hash));`;

// Matching the source revision preserves the old failure receipt while edits get a fresh budget.
export const generationReady = `NOT EXISTS (SELECT 1 FROM pilot_generation_failures f
  WHERE f.source_id=s.id AND f.source_hash=s.hash
  AND (f.failure_count>=${generationFailureLimit} OR f.next_attempt_at>now()))`;
export const generationAttempts = `coalesce((SELECT f.failure_count FROM pilot_generation_failures f
  WHERE f.source_id=s.id AND f.source_hash=s.hash),0) AS generation_failures`;

export function validateGenerationFailureBatch(batch) {
  if (
    !batch ||
    typeof batch !== "object" ||
    Array.isArray(batch) ||
    !Array.isArray(batch.rows) ||
    !batch.rows.length ||
    batch.rows.length > 12 ||
    batch.historyEpisode ||
    batch.operatorRequest ||
    (batch.replyTo != null && (batch.rows.length !== 1 || batch.rows[0]?.id !== batch.replyTo)) ||
    batch.rows.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        typeof row.id !== "string" ||
        !/^\d{17,20}$/.test(row.id) ||
        typeof row.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.hash) ||
        (row.source != null &&
          (typeof row.source !== "object" ||
            Array.isArray(row.source) ||
            row.source.id !== row.id)),
    ) ||
    new Set(batch.rows.map((row) => row.id)).size !== batch.rows.length
  )
    throw new Error("Invalid live generation failure targets");
}

export async function deferGeneration(store, batch) {
  validateGenerationFailureBatch(batch);
  if (typeof store?.deferGeneration !== "function")
    throw new Error("Guarded generation failure recording is unavailable");
  return store.deferGeneration(batch);
}

export async function generationFailureStatus(db) {
  const exists = (await db.query("SELECT to_regclass('public.pilot_generation_failures') AS name"))
    .rows[0].name;
  if (!exists) return [];
  return (
    await db.query(`SELECT f.source_id,f.failure_count,f.next_attempt_at,
    f.failure_count>=${generationFailureLimit} AS held
    FROM pilot_generation_failures f JOIN pilot_sources s ON s.id=f.source_id AND s.hash=f.source_hash
    WHERE NOT s.deleted AND s.learnable AND (NOT s.learned OR
      (s.addressed AND NOT EXISTS(SELECT 1 FROM pilot_outbox o WHERE o.source_id=s.id)))
    ORDER BY f.last_failed_at DESC`)
  ).rows;
}
