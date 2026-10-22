import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ms = (value) => new Date(value).getTime();
const unique = (values) => [...new Set(values)];
const kind = (event) =>
  event.historyEpisode
    ? "historical"
    : event.operatorRequestId
      ? "operator"
      : event.replyTo
        ? "ordinary"
        : "ambient";
const round = (value) => Math.round(value * 1000) / 1000;

export function unionDuration(intervals, from = -Infinity, to = Infinity) {
  const sorted = intervals
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((a, b) => a[0] - b[0]);
  let end = -Infinity,
    total = 0;
  for (const [a, b] of sorted) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}

// Read receipts, never the cache's learned=true flag, establish reviewed targets.
export function reviewMetrics(episodes, works, since) {
  const selected = unique(episodes.flatMap((e) => e.manifest.sourceIds ?? []));
  const contexts = unique(episodes.flatMap((e) => e.context_ids ?? []));
  const completed = works.filter((w) => w.status === "done" && w.history_episode);
  const first = new Map();
  for (const work of completed.sort(
    (a, b) => ms(a.completed_at ?? a.created_at) - ms(b.completed_at ?? b.created_at),
  )) {
    const observations = new Map((work.observations ?? []).map((o) => [o.messageId, o.decision]));
    for (const id of work.source_ids)
      if (!first.has(id))
        first.set(id, {
          id,
          workId: work.id,
          episodeId: work.history_episode,
          completedAt: work.completed_at,
          decision: observations.get(id) ?? "unrecorded",
          automatic: work.history_episode.startsWith("auto-"),
        });
  }
  const recent = [...first.values()].filter((r) => r.completedAt && ms(r.completedAt) >= ms(since));
  const statuses = {};
  for (const e of episodes) statuses[e.status] = (statuses[e.status] ?? 0) + 1;
  return {
    selectedTargetIds: selected,
    loadedContextIds: contexts,
    committedTargetIds: [...first.keys()],
    recentFirstReviews: recent,
    recentReviewCount: recent.length,
    recentByOrigin: Object.fromEntries(
      ["automatic", "manual"].map((origin) => {
        const group = recent.filter((r) => r.automatic === (origin === "automatic"));
        return [
          origin,
          {
            reviewed: group.length,
            retained: group.filter((r) => r.decision === "retained").length,
            irrelevant: group.filter((r) => r.decision === "irrelevant").length,
          },
        ];
      }),
    ),
    recentRetainedCount: recent.filter((r) => r.decision === "retained").length,
    recentIrrelevantCount: recent.filter((r) => r.decision === "irrelevant").length,
    recentUnrecordedDecisionCount: recent.filter((r) => r.decision === "unrecorded").length,
    completedTargetOccurrences: completed.reduce((n, w) => n + w.source_ids.length, 0),
    repeatedCompletedTargetOccurrences:
      completed.reduce((n, w) => n + w.source_ids.length, 0) - first.size,
    firstReviewsWithoutExactCompletion: [...first.values()].filter((r) => !r.completedAt).length,
    statuses,
  };
}

export function transcriptMetrics(text, since) {
  const inputs = new Map(),
    cycles = [],
    models = [],
    deliveries = [],
    sources = new Map(),
    admissions = [],
    errors = [];
  text.split("\n").forEach((line, index) => {
    if (!line) return;
    const e = JSON.parse(line),
      ref = { line: index + 1, at: e.at };
    if (e.type === "input") {
      inputs.set(e.otid, {
        ...ref,
        pid: e.pid,
        kind: e.input.context?.historicalEpisode
          ? "historical"
          : e.input.operatorRequest
            ? "operator"
            : e.input.addressedToBot
              ? "ordinary"
              : "ambient",
        targets: e.input.messages.map((s) => s.id),
      });
      for (const s of e.input.messages) if (s.createdAt) sources.set(s.id, s.createdAt);
    }
    if (e.type === "discord_source" && e.source?.createdAt)
      sources.set(e.source.id, e.source.createdAt);
    if (e.type === "latency" && e.scope === "cycle") cycles.push({ ...ref, ...e, kind: kind(e) });
    if (e.type === "latency" && e.scope === "model") models.push({ ...ref, ...e });
    if (e.type === "discord_reply")
      deliveries.push({ ...ref, sourceId: e.sourceId, replyId: e.id });
    if (e.type === "history_automation_admitted")
      admissions.push({
        ...ref,
        episodeId: e.episodeId,
        selectedCount: e.selectedIds?.length,
        targetCount: e.sourceIds?.length,
        exhausted: e.exhausted,
      });
    if (
      [
        "failure",
        "history_episode_failure",
        "history_candidate_failure",
        "history_admission_deferred",
        "operator_generation_failed",
      ].includes(e.type)
    )
      errors.push({
        ...ref,
        type: e.type,
        error: e.error ?? e.detail,
        episodeId: e.historyEpisode ?? e.episodeId,
      });
  });
  const recentCycles = cycles.filter((e) => ms(e.at) >= ms(since));
  const recentModels = models
    .filter((e) => ms(e.at) >= ms(since))
    .map((e) => {
      const stages = e.stages.map((s) => ({
        phase: s.phase,
        durationMs: round(s.durationMs),
        success: s.success,
      }));
      return {
        line: e.line,
        at: e.at,
        startedAt: e.startedAt,
        kind: inputs.get(e.otid)?.kind ?? "unknown",
        otid: e.otid,
        stages,
        toolUnionMs: round(
          unionDuration(
            e.stages
              .filter((s) => s.phase.startsWith("tool:"))
              .map((s) => [s.offsetMs, s.offsetMs + s.durationMs]),
          ),
        ),
        note: "Tool execution overlaps model_stream. tools_drain is the remaining tail after the stream.",
      };
    });
  const spans = cycles.flatMap((c) =>
    c.stages.map((s) => ({
      kind: c.kind,
      phase: s.phase,
      from: ms(c.startedAt) + s.offsetMs,
      to: ms(c.startedAt) + s.offsetMs + s.durationMs,
    })),
  );
  const ordinary = deliveries
    .filter((d) => ms(d.at) >= ms(since))
    .map((d) => {
      const createdAt = sources.get(d.sourceId),
        from = ms(createdAt),
        to = ms(d.at);
      const cycle = cycles.find((c) => c.replyTo === d.sourceId && ms(c.at) >= to);
      const phaseIntervals =
        cycle?.stages.map((s) => [
          ms(cycle.startedAt) + s.offsetMs,
          ms(cycle.startedAt) + s.offsetMs + s.durationMs,
        ]) ?? [];
      const beforeWork = ms(cycle?.startedAt);
      const waitingSpans = spans
        .filter((s) => s.to <= beforeWork || s.from < beforeWork)
        .map((s) => [s.from, Math.min(s.to, beforeWork)]);
      const assigned = unionDuration([...phaseIntervals, ...waitingSpans], from, to);
      return {
        ...d,
        createdAt: createdAt ?? null,
        totalMs: createdAt ? round(to - from) : null,
        cycleLine: cycle?.line ?? null,
        phases:
          cycle?.stages.map((s) => ({ phase: s.phase, durationMs: round(s.durationMs) })) ?? [],
        observedPriorWorkMs: createdAt ? round(unionDuration(waitingSpans, from, to)) : null,
        observedPriorWorkByKindMs: Object.fromEntries(
          ["historical", "operator", "ordinary", "ambient"].map((k) => [
            k,
            createdAt
              ? round(
                  unionDuration(
                    spans
                      .filter((s) => s.kind === k)
                      .map((s) => [s.from, Math.min(s.to, beforeWork)]),
                    from,
                    to,
                  ),
                )
              : null,
          ]),
        ),
        unassignedMs: createdAt ? round(Math.max(0, to - from - assigned)) : null,
        note: "Unassigned includes idle polling and unlogged work; overlapping intervals are counted once. Earlier-work kind totals can overlap and must not be summed.",
      };
    });
  const summaries = {};
  for (const category of ["historical", "operator", "ordinary", "ambient"]) {
    const group = recentCycles.filter((c) => c.kind === category),
      phases = {};
    for (const c of group) for (const s of c.stages) (phases[s.phase] ??= []).push(s.durationMs);
    summaries[category] = {
      cycles: group.length,
      phases: Object.fromEntries(
        Object.entries(phases).map(([name, values]) => [
          name,
          {
            count: values.length,
            totalMs: round(values.reduce((a, b) => a + b, 0)),
            meanMs: round(values.reduce((a, b) => a + b, 0) / values.length),
            maxMs: round(Math.max(...values)),
          },
        ]),
      ),
    };
  }
  const finishedModels = new Set(models.map((m) => m.otid));
  return {
    summaries,
    ordinaryDelivered: ordinary,
    models: recentModels,
    inputsWithoutCompletedModelTiming: [...inputs]
      .filter(([id, e]) => !finishedModels.has(id) && ms(e.at) >= ms(since))
      .map(([otid, e]) => ({ otid, ...e })),
    admissions: admissions.filter((e) => ms(e.at) >= ms(since)),
    recentErrors: errors.filter((e) => ms(e.at) >= ms(since)),
    recentCycles: recentCycles.map((c) => ({
      line: c.line,
      at: c.at,
      startedAt: c.startedAt,
      kind: c.kind,
      historyEpisode: c.historyEpisode,
      operatorRequestId: c.operatorRequestId,
      stages: c.stages,
    })),
  };
}

async function readonly(credentials, action) {
  const db = new pg.Client({
    ...credentials,
    statement_timeout: 20000,
    options: "-c default_transaction_read_only=on",
  });
  await db.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await action(db);
  } finally {
    await db.query("ROLLBACK").finally(() => db.end());
  }
}

export async function collectMetrics(state, since) {
  const json = async (name) => JSON.parse(await readFile(join(state, name), "utf8"));
  const [live, archive, profile, health, recovery] = await Promise.all([
    json("postgres.json"),
    json("history-postgres.json"),
    json("history-automation.json"),
    json("pilot-health.json"),
    json("pilot-recovery.json"),
  ]);
  if (
    live.host !== "127.0.0.1" ||
    live.database !== "mudfut_pilot" ||
    archive.host !== "127.0.0.1" ||
    archive.user !== "mudfut_history_reader"
  )
    throw Error("Unexpected PostgreSQL authority");
  const result = {
    capturedAt: new Date().toISOString(),
    since,
    mode: "read-only",
    profile,
    health,
    recovery,
  };
  result.elapsedObservationSeconds = (ms(result.capturedAt) - ms(since)) / 1000;
  result.database = await readonly(live, async (db) => {
    const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
    const episodes = await rows(
      "SELECT id,pass_id,manifest,status,read_ids,context_ids,work_id,created_at,completed_at,failure_count,next_attempt_at FROM pilot_history_episodes ORDER BY created_at,id",
    );
    const works = await rows(`SELECT w.id,w.status,w.history_episode,w.source_ids,w.created_at,
      COALESCE(e.completed_at,c.completed_at) AS completed_at,
      (SELECT jsonb_agg(o) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.candidate->'audit')='array' THEN w.candidate->'audit' ELSE jsonb_build_array(w.candidate->'audit') END) a
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a->'observations','[]')) o) AS observations
      FROM pilot_work w LEFT JOIN pilot_history_episodes e ON e.work_id=w.id AND e.status='done'
      LEFT JOIN LATERAL (SELECT min(created_at) completed_at FROM pilot_memory_commits WHERE work_id=w.id) c ON true
      WHERE w.history_episode IS NOT NULL ORDER BY w.created_at,w.id`);
    return {
      identity: (
        await rows(
          "SELECT agent_id,revision,commit_id,pg_postmaster_start_time() AS server_started_at,current_database() AS database FROM pilot_memory_meta",
        )
      )[0],
      memory: (
        await rows(
          "SELECT (SELECT count(*) FROM pilot_memory_entries p JOIN pilot_memory_versions v ON v.id=p.version_id WHERE NOT v.tombstone)::int AS current_entries,(SELECT count(*) FROM pilot_memory_versions)::int AS preserved_versions,(SELECT count(*) FROM pilot_memory_commits)::int AS commits",
        )
      )[0],
      review: reviewMetrics(episodes, works, since),
      recentMemoryChanges: await rows(
        "SELECT count(*)::int AS version_rows,count(*) FILTER(WHERE v.previous_version_id IS NULL AND NOT v.tombstone)::int AS added_keys,count(*) FILTER(WHERE v.previous_version_id IS NOT NULL AND NOT v.tombstone)::int AS revisions,count(*) FILTER(WHERE v.tombstone)::int AS tombstones FROM pilot_memory_versions v JOIN pilot_memory_commits c ON c.id=v.commit_id JOIN pilot_work w ON w.id=c.work_id WHERE w.history_episode IS NOT NULL AND c.created_at >= $1",
        [since],
      ),
      episodes: episodes.map(({ manifest, ...e }) => ({
        ...e,
        targetCount: manifest.sourceIds?.length ?? 0,
      })),
      workStatuses: await rows(
        "SELECT status,count(*)::int AS count FROM pilot_work GROUP BY status ORDER BY status",
      ),
      cursors: await rows("SELECT * FROM pilot_history_automation ORDER BY id"),
      failures: await rows(
        "SELECT episode_id,attempt_no,retry_index,phase,classification,outcome,next_attempt_at,created_at,detail FROM pilot_history_failures ORDER BY created_at DESC LIMIT 30",
      ),
      admissionFailures: await rows(
        "SELECT fingerprint,path,created_at,detail FROM pilot_history_admission_failures ORDER BY created_at DESC LIMIT 10",
      ),
    };
  });
  result.coverage = await readonly(archive, async (db) => {
    const review = result.database.review,
      selected = new Set(review.selectedTargetIds),
      committed = new Set(review.committedTargetIds),
      context = new Set(review.loadedContextIds);
    const coverage = [];
    for (const channel of profile.channels) {
      const rows = (
        await db.query(
          "SELECT message_id,created_at,author_id FROM messages WHERE guild_id=$1 AND channel_id=$2 AND thread_id IS NULL AND deleted_at IS NULL AND content IS NOT NULL AND created_at >= $3 AND created_at <= $4 ORDER BY created_at,message_id",
          [channel.guildId, channel.channelId, channel.start, channel.end],
        )
      ).rows;
      const ids = rows.map((r) => r.message_id);
      const reviewed = rows.filter((r) => committed.has(r.message_id));
      coverage.push({
        ...channel,
        availableMessages: rows.length,
        authors: new Set(rows.map((r) => r.author_id)).size,
        firstAvailableAt: rows[0]?.created_at ?? null,
        lastAvailableAt: rows.at(-1)?.created_at ?? null,
        firstCommittedAt: reviewed[0]?.created_at ?? null,
        lastCommittedAt: reviewed.at(-1)?.created_at ?? null,
        cursor:
          result.database.cursors.find((c) => c.id === `${profile.id}:${channel.channelId}`) ??
          null,
        selectedTargets: ids.filter((id) => selected.has(id)).length,
        committedTargets: ids.filter((id) => committed.has(id)).length,
        selectedNotCommitted: ids.filter((id) => selected.has(id) && !committed.has(id)).length,
        loadedContextOnly: ids.filter((id) => context.has(id) && !selected.has(id)).length,
        merelySearchable: ids.filter((id) => !selected.has(id) && !context.has(id)).length,
      });
    }
    return coverage;
  });
  // ponytail: one on-demand snapshot scans the current transcript and configured archive IDs;
  // sustained collection or larger archives should use append offsets and indexed ID joins.
  const transcriptPath = join(state, "transcripts/pilot.jsonl"),
    bytes = await readFile(transcriptPath),
    complete = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
  result.transcript = {
    path: transcriptPath,
    capturedAt: new Date().toISOString(),
    completeBytes: complete.length,
    trailingIncompleteBytes: bytes.length - complete.length,
    sha256: createHash("sha256").update(complete).digest("hex"),
    ...transcriptMetrics(complete.toString("utf8"), since),
  };
  result.runtimeRevision = (
    await promisify(execFile)("git", ["rev-parse", "HEAD"], {
      cwd: resolve(state, "../letta-handoff"),
    })
  ).stdout.trim();
  result.notes = [
    "Database snapshots and transcript captures are individually consistent but not mutually atomic.",
    "Archive counts are candidate messages; bots are excluded by live source validation, not inferred from the archive schema.",
    "Selected and loaded context are not completed reads. A retained decision is a write outcome, not demonstrated recall.",
    "First/last committed source dates bound scattered reads; they do not prove that the intervening history was read. Automatic cursors and unique target counts establish actual progress.",
    "Committed target counts identify successful historical reviews by stable message ID, not a guarantee that every later edited version has been reread. Episode status separately records requeued work.",
    "Recent review counts deduplicate completed target IDs across all history work; replays are excluded. Missing exact completion times are reported separately.",
    "Tools overlap model_stream; tools_drain reports remaining tool cleanup after the stream. Unassigned ordinary wait stays unassigned.",
    "Recent errors and failure ledger details are private. No live messages, model calls or database mutations were made.",
  ];
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [state, output, suppliedSince] = process.argv.slice(2);
  if (!state || !output)
    throw Error("Usage: node pilot-learning-metrics.mjs PRIVATE_STATE PRIVATE_OUTPUT [SINCE_ISO]");
  const since = suppliedSince ?? new Date(Date.now() - 3600000).toISOString();
  if (!Number.isFinite(ms(since))) throw Error("Invalid since timestamp");
  const destination = resolve(output);
  if (destination.startsWith(resolve(dirname(fileURLToPath(import.meta.url)), "../..") + "/"))
    throw Error("Metrics must be saved outside the code repository");
  const result = await collectMetrics(resolve(state), since);
  await writeFile(destination, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(
    JSON.stringify({
      output: destination,
      capturedAt: result.capturedAt,
      reviewedSince: result.database.review.recentReviewCount,
      retainedSince: result.database.review.recentRetainedCount,
      ordinaryDelivered: result.transcript.ordinaryDelivered.length,
    }),
  );
}
