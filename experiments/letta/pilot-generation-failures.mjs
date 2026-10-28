// Incomplete model output is a work-item failure, never permission to invent decisions.
export const generationFailureLimit = 3;
export function requireObservationDecisions(complete) {
  if (!complete)
    throw Object.assign(
      new Error("Model omitted explicit observation decisions; work remains unlearned"),
      { code: "MODEL_OBSERVATIONS_INCOMPLETE" },
    );
}

export function incompleteLiveTurn(error, { batch, phase, stopping, connectionFailure }) {
  return Boolean(
    error?.code === "MODEL_OBSERVATIONS_INCOMPLETE" &&
    phase === "model" &&
    !stopping &&
    !connectionFailure &&
    batch?.rows?.length &&
    !batch.historyEpisode &&
    !batch.operatorRequest,
  );
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

export async function deferGeneration(store, batch) {
  if (
    !batch?.rows?.length ||
    batch.historyEpisode ||
    batch.operatorRequest ||
    batch.rows.some((row) => !/^\d{17,20}$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.hash)) ||
    new Set(batch.rows.map((row) => row.id)).size !== batch.rows.length
  )
    throw new Error("Invalid live generation failure targets");
  return store.transaction(async () => {
    const receipts = [];
    for (const row of batch.rows) {
      const result = await store.db.query(
        `INSERT INTO pilot_generation_failures(source_id,source_hash,failure_count,next_attempt_at)
         SELECT id,hash,1,now()+interval '30 seconds' FROM pilot_sources
         WHERE id=$1 AND hash=$2 AND NOT deleted AND learnable
         ON CONFLICT(source_id,source_hash) DO UPDATE SET
         failure_count=pilot_generation_failures.failure_count+1,
         next_attempt_at=now()+interval '2 minutes',last_failed_at=now()
         RETURNING source_id,source_hash,failure_count,next_attempt_at`,
        [row.id, row.hash],
      );
      receipts.push(...result.rows);
    }
    return receipts;
  });
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
