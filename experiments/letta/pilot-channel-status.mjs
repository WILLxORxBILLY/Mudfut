import { generationFailureStatus } from "./pilot-generation-failures.mjs";
import { replyChannels, validateScope, snowflake } from "./pilot-store.mjs";

const errorCode = (error) => ({
  code: /^[A-Z0-9_]{1,40}$/.test(String(error?.code ?? "")) ? String(error.code) : null,
  status: Number.isInteger(error?.status) ? error.status : null,
});
const fresh = (at, now) =>
  Number.isFinite(Date.parse(at)) && now - Date.parse(at) >= 0 && now - Date.parse(at) <= 240000;
const matchingPoll = (poll, config) => {
  const ids = replyChannels(config);
  return (
    poll?.schemaVersion === 1 &&
    poll.guildId === config.guildId &&
    Array.isArray(poll.routes) &&
    (poll.replyScope ?? "configured") === (config.replyScope ?? "configured") &&
    new Set(poll.routes.map((route) => route?.id)).size === poll.routes.length &&
    (config.replyScope === "guild"
      ? poll.routes.every(
          (route) => snowflake(route?.id) && [0, 2, 5, 13, 15, 16].includes(route.type),
        )
      : poll.routes.length === ids.length &&
        poll.routes.every((route) => ids.includes(route?.id))) &&
    poll.polls &&
    typeof poll.polls === "object" &&
    !Array.isArray(poll.polls) &&
    poll.threads &&
    typeof poll.threads === "object" &&
    !Array.isArray(poll.threads) &&
    Array.isArray(poll.activeChannelIds)
  );
};

export function channelPollStatus(config, routes, { initial, save, now = Date.now }) {
  validateScope(config);
  const snapshot = matchingPoll(initial, config)
    ? structuredClone(initial)
    : { schemaVersion: 1, guildId: config.guildId, polls: {}, threads: {}, activeChannelIds: [] };
  snapshot.routes = routes;
  snapshot.replyScope = config.replyScope ?? "configured";
  let saving = Promise.resolve();
  const publish = async () => {
    snapshot.at = new Date(now()).toISOString();
    const copy = structuredClone(snapshot);
    saving = saving.then(() => save(copy));
    await saving;
  };
  return {
    async discoveryFailed(error) {
      snapshot.discovery = { at: new Date(now()).toISOString(), ok: false, ...errorCode(error) };
      await publish();
    },
    async polled(discovered, results) {
      const discoveredAt = discovered.at ?? new Date(now()).toISOString();
      if (!snapshot.discovery || Date.parse(discoveredAt) >= Date.parse(snapshot.discovery.at)) {
        snapshot.discovery = { at: discoveredAt, ok: true };
        snapshot.activeChannelIds = discovered.channelIds;
        if (discovered.routes) snapshot.routes = discovered.routes;
      }
      for (const thread of discovered.threads) snapshot.threads[thread.id] = thread.parent_id;
      for (const result of results) {
        const previous = snapshot.polls[result.channelId] ?? {};
        if (Date.parse(previous.lastAttemptAt) > Date.parse(result.at)) continue;
        snapshot.polls[result.channelId] = {
          ...previous,
          lastAttemptAt: result.at,
          ok: result.ok,
          ...(result.ok
            ? { lastSuccessAt: result.at, code: null, status: null }
            : { lastFailureAt: result.at, ...errorCode(result.error) }),
        };
      }
      await publish();
    },
  };
}

export async function channelStatus(
  db,
  config,
  { poll, health, recovery, archive, now = Date.now() } = {},
) {
  validateScope(config);
  const observed = matchingPoll(poll, config) ? poll : null;
  const configured =
    config.replyScope === "guild" && observed
      ? observed.routes.map((route) => route.id)
      : replyChannels(config);
  const report = {
    observedAt: new Date(now).toISOString(),
    replyScope: config.replyScope ?? "configured",
    runtime: {
      state: recovery?.held
        ? "held"
        : !recovery?.running
          ? "stopped-or-unobserved"
          : health?.pid === recovery.workerPid && fresh(health.at, now)
            ? "recent-progress"
            : "stale-or-unobserved",
      health: health ?? null,
    },
    archive: archive ?? { state: "unobserved" },
    limitations: [
      "Read-only local observations; no Discord, permission probe or model calls.",
      "A successful poll proves read access at its timestamp, not send permission or delivered replies.",
      "Sent outbox receipts record Discord acceptance; they are not fresh Discord existence checks.",
      "Forum summaries include retained thread state; active endpoints and per-thread failures are listed separately.",
    ],
  };
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const tables = (
      await db.query(`SELECT to_regclass('public.pilot_meta') meta,
      to_regclass('public.pilot_sources') sources,to_regclass('public.pilot_outbox') outbox,
      to_regclass('public.pilot_live_threads') threads,to_regclass('public.pilot_source_holds') holds`)
    ).rows[0];
    if (Object.values(tables).some((value) => !value))
      return { ...report, initialized: false, channels: [] };
    const meta = (await db.query("SELECT scope,cursors FROM pilot_meta")).rows[0];
    report.scopeMatches = Boolean(
      meta &&
      meta.scope.guildId === config.guildId &&
      (meta.scope.replyScope ?? "configured") === (config.replyScope ?? "configured") &&
      replyChannels(meta.scope).length === replyChannels(config).length &&
      replyChannels(meta.scope).every((id) => replyChannels(config).includes(id)),
    );
    const threads = (
      await db.query(
        "SELECT channel_id,parent_id FROM pilot_live_threads WHERE guild_id=$1 AND parent_id=ANY($2::text[])",
        [config.guildId, configured],
      )
    ).rows;
    const endpoints = [...new Set([...configured, ...threads.map((thread) => thread.channel_id)])];
    report.unassignedDeliveries = (
      await db.query(
        `SELECT o.status,count(*)::int count
      FROM pilot_outbox o LEFT JOIN pilot_sources s ON s.id=o.source_id
      WHERE s.id IS NULL OR s.source->>'guildId' IS DISTINCT FROM $1
        OR NOT coalesce(s.source->>'channelId'=ANY($2::text[]),false)
      GROUP BY o.status`,
        [config.guildId, endpoints],
      )
    ).rows;
    report.attention = report.unassignedDeliveries.some((row) => row.status !== "sent")
      ? ["unassigned-delivery-requires-inspection"]
      : [];
    report.generationFailures = await generationFailureStatus(db);
    if (report.generationFailures.some((row) => row.held))
      report.attention.push("live-generation-held-requires-inspection");
    const counts = (
      await db.query(
        `SELECT s.source->>'channelId' AS channel_id,
      count(*) FILTER(WHERE s.addressed AND s.learnable AND NOT s.deleted AND o.source_id IS NULL AND h.source_id IS NULL)::int pending,
      count(*) FILTER(WHERE s.addressed AND s.learnable AND NOT s.deleted AND o.source_id IS NULL AND h.source_id IS NOT NULL)::int source_holds,
      count(*) FILTER(WHERE o.status='ready')::int ready,
      count(*) FILTER(WHERE o.status='sending')::int sending,
      count(*) FILTER(WHERE o.status='held')::int held,
      count(*) FILTER(WHERE o.status='sent' AND o.discord_id IS NULL)::int missing_receipts
      FROM pilot_sources s LEFT JOIN pilot_outbox o ON o.source_id=s.id
      LEFT JOIN pilot_source_holds h ON h.source_id=s.id
      WHERE s.source->>'guildId'=$1 AND s.source->>'channelId'=ANY($2::text[])
      GROUP BY s.source->>'channelId'`,
        [config.guildId, endpoints],
      )
    ).rows;
    const deliveries = (
      await db.query(
        `SELECT DISTINCT ON(s.source->>'channelId')
      s.source->>'channelId' AS channel_id,o.source_id,o.discord_id,o.attempted_at
      FROM pilot_outbox o JOIN pilot_sources s ON s.id=o.source_id
      WHERE o.status='sent' AND s.source->>'guildId'=$1 AND s.source->>'channelId'=ANY($2::text[])
      ORDER BY s.source->>'channelId',o.attempted_at DESC NULLS LAST,
        CASE WHEN o.discord_id ~ '^[1-9][0-9]{16,19}$' THEN o.discord_id::numeric END DESC NULLS LAST`,
        [config.guildId, endpoints],
      )
    ).rows;
    const countsById = new Map(counts.map((row) => [row.channel_id, row]));
    const deliveriesById = new Map(deliveries.map((row) => [row.channel_id, row]));
    const threadsByParent = Map.groupBy(threads, (thread) => thread.parent_id);
    const endpoint = (id) => {
      const reading = observed?.polls?.[id];
      const count = countsById.get(id) ?? {};
      const sent = deliveriesById.get(id);
      const validReceipt =
        sent &&
        /^[1-9]\d{16,19}$/.test(sent.discord_id ?? "") &&
        BigInt(sent.discord_id) <= 18446744073709551615n;
      const blockers = [];
      if (reading?.ok === false) blockers.push("last-poll-failed");
      if (count.held) blockers.push("ambiguous-or-held-delivery");
      if (count.source_holds) blockers.push("addressed-source-held");
      if (count.missing_receipts || (sent && !validReceipt))
        blockers.push("invalid-delivery-receipt");
      if (count.pending && observed && !observed.activeChannelIds.includes(id))
        blockers.push("inactive-endpoint-pending");
      return {
        channelId: id,
        active: observed?.activeChannelIds?.includes(id) ?? null,
        cursor: meta?.cursors[id] ?? null,
        readState:
          reading?.ok === false
            ? "failed"
            : fresh(reading?.lastSuccessAt, now)
              ? "recent-success"
              : reading?.lastSuccessAt
                ? "stale-success"
                : "unobserved",
        lastPollAttemptAt: reading?.lastAttemptAt ?? null,
        lastSuccessfulPollAt: reading?.lastSuccessAt ?? null,
        lastPollFailureAt: reading?.lastFailureAt ?? null,
        lastPollErrorCode: reading?.code ?? null,
        lastPollHttpStatus: reading?.status ?? null,
        pendingAddressed: count.pending ?? 0,
        heldSources: count.source_holds ?? 0,
        readyReplies: count.ready ?? 0,
        sendingReplies: count.sending ?? 0,
        heldReplies: count.held ?? 0,
        lastDeliveredReply: validReceipt
          ? {
              sourceId: sent.source_id,
              messageId: sent.discord_id,
              attemptedAt: sent.attempted_at,
              url: `https://discord.com/channels/${config.guildId}/${id}/${sent.discord_id}`,
            }
          : null,
        blockers,
      };
    };
    report.channels = configured.map((id) => {
      const route = observed?.routes.find((item) => item.id === id);
      const children = (threadsByParent.get(id) ?? []).map((thread) => thread.channel_id);
      const forum = [15, 16].includes(route?.type) || (!route && children.length > 0);
      const rows = (forum ? children : [id, ...children]).map(endpoint);
      const blockers = [
        ...new Set(
          rows.flatMap((row) =>
            row.blockers.filter(
              (blocker) => row.active !== false || blocker !== "last-poll-failed",
            ),
          ),
        ),
      ];
      if (!report.scopeMatches) blockers.push("persisted-scope-mismatch");
      if (report.runtime.state !== "recent-progress")
        blockers.push("worker-" + report.runtime.state);
      if (observed?.discovery?.ok === false) blockers.push("thread-discovery-failed");
      return {
        channelId: id,
        name: route?.name ?? null,
        type: forum
          ? "forum"
          : [2, 13].includes(route?.type)
            ? "voice-text"
            : route
              ? "text"
              : "unobserved",
        configured: true,
        activeEndpoints: rows.filter((row) => row.active).length,
        readState: forum
          ? observed?.discovery?.ok === false
            ? "discovery-failed"
            : !fresh(observed?.discovery?.at, now)
              ? "stale-or-unobserved-discovery"
              : !rows.some((row) => row.active)
                ? "no-active-discussions"
                : rows.some((row) => row.active && row.readState !== "recent-success")
                  ? "incomplete"
                  : "recent-success"
          : rows[0].readState,
        discoveryAt: observed?.discovery?.at ?? null,
        pendingAddressed: rows.reduce((sum, row) => sum + row.pendingAddressed, 0),
        blockers,
        endpoints: rows,
      };
    });
    return { ...report, initialized: true };
  } finally {
    await db.query("ROLLBACK");
  }
}
