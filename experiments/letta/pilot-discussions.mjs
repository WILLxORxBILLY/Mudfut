import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  archiveDictionary,
  archiveInput,
  archiveMatches,
  archiveRelevance,
  currentSources,
} from "./pilot-discord.mjs";
import { sourceRecord, snowflake } from "./pilot-store.mjs";

const filterKeys = [
  "query",
  "authorIds",
  "channelIds",
  "after",
  "before",
  "oldestFirst",
  "matchMode",
];
const tuple = (row) => ({ at: row.at, id: row.id });
const compare = (a, b) =>
  a.at.localeCompare(b.at) ||
  (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
const columns = `m.message_id AS id,m.guild_id AS "guildId",m.channel_id AS "channelId",
  to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;
const coverage = {
  authority: "Archive index selection; returned originals freshly validated against Discord",
  threads: "Thread messages excluded; parent-channel neighbors do not establish thread membership",
  interpretation:
    "Searchable/index-selected messages are not proof of prior reading or retained understanding",
};

export function archiveDiscussions(
  store,
  discord,
  config,
  history,
  { checkpoint = async () => {}, now = Date.now } = {},
) {
  if (!history) throw new Error("Archive discussions require an archive connection");
  // ponytail: 64 worker-local cursor states freeze at most 144 index identities
  // each for 15 minutes, without holding MVCC transactions. Restart/eviction
  // invalidates tokens; persistent receipts are the upgrade for longer browsing.
  const secret = randomBytes(32);
  const cursors = new Map();
  const ttl = 15 * 60 * 1000;
  const sign = (body) => createHmac("sha256", secret).update(body).digest();
  const pack = (value) => {
    const body = sign(JSON.stringify(value)).toString("base64url").slice(0, 22);
    for (const [key, entry] of cursors) if (entry.expiresAt <= now()) cursors.delete(key);
    if (!cursors.has(body))
      cursors.set(body, { state: structuredClone(value), expiresAt: now() + ttl });
    while (cursors.size > 64) cursors.delete(cursors.keys().next().value);
    return body + "." + sign(body).toString("base64url");
  };
  const unpack = (value) => {
    if (typeof value !== "string" || value.length > 128 || !/^[\w-]{22}\.[\w-]{43}$/.test(value))
      throw new Error("Invalid archive cursor");
    const [body, signature] = value.split(".");
    const actual = Buffer.from(signature, "base64url"),
      expected = sign(body);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("Archive cursor changed or belongs to another worker");
    const saved = cursors.get(body);
    if (!saved)
      throw new Error(
        "Archive cursor expired or was evicted from the 64-token worker cache; start a new bounded chain",
      );
    if (saved.expiresAt <= now()) {
      cursors.delete(body);
      throw new Error("Archive cursor expired after 15 minutes; start a new bounded chain");
    }
    return structuredClone(saved.state);
  };
  async function fresh(rows) {
    await checkpoint();
    const originals = await currentSources(discord, rows, checkpoint);
    const result = [];
    for (const row of rows) {
      const current = originals.get(row.id);
      if (!current) {
        await store.remove(row.id);
        continue;
      }
      if (current.id !== row.id)
        throw new Error("Discord original identity differs from archive candidate");
      if (current.author?.bot || current.author?.id === config.botId) continue;
      const source = sourceRecord(current, row.guildId, row.channelId);
      await store.ingest(source, false, false);
      if (store.isHeld && (await store.isHeld(source.id))) continue;
      result.push(source);
    }
    return result;
  }
  async function exact(id) {
    const row = (
      await history.query(
        `SELECT ${columns},m.thread_id AS "threadId" FROM messages m
      WHERE m.message_id=$1 AND m.deleted_at IS NULL AND m.content IS NOT NULL`,
        [id],
      )
    ).rows[0];
    if (!row) return { gap: "not-in-current-archive-index" };
    if (row.threadId) return { gap: "thread-excluded" };
    return { row, source: (await fresh([row]))[0] };
  }
  return {
    async findChronologicalGap(intervals, knownIds) {
      await checkpoint();
      // Each interval is bounded by inspected originals; a capped index count
      // checks for actual unread messages, not merely elapsed calendar time.
      const rows = (
        await history.query(
          `SELECT g.value AS gap, u.n AS "unreadCountCapped"
          FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS g(value,ord)
          CROSS JOIN LATERAL (
            SELECT count(*)::int AS n FROM (
              SELECT 1 FROM messages m
              WHERE m.guild_id=g.value->>'guildId' AND m.channel_id=g.value->>'channelId'
              AND m.deleted_at IS NULL AND m.content IS NOT NULL AND m.thread_id IS NULL
              AND (m.created_at,m.message_id::numeric)>=((g.value->>'after')::timestamptz,(g.value->>'fromId')::numeric)
              AND (m.created_at,m.message_id::numeric)<=((g.value->>'before')::timestamptz,(g.value->>'toId')::numeric)
              AND NOT (m.message_id=ANY($2::text[])) LIMIT 25
            ) unread
          ) u WHERE u.n>0 ORDER BY u.n DESC,g.ord LIMIT 1`,
          [JSON.stringify(intervals), knownIds],
        )
      ).rows;
      return rows.length ? { ...rows[0].gap, unreadCountCapped: rows[0].unreadCountCapped } : null;
    },
    async browseArchive(input) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => ![...filterKeys, "limit", "cursor"].includes(key))
      )
        throw new Error("Invalid archive browsing options");
      const supplied = Object.fromEntries(
        filterKeys.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]),
      );
      let chain;
      if (Object.hasOwn(input, "cursor")) {
        chain = unpack(input.cursor);
        if (
          (Object.keys(supplied).length &&
            JSON.stringify(supplied) !== JSON.stringify(chain.filters)) ||
          (Object.hasOwn(input, "limit") && input.limit !== chain.limit)
        )
          throw new Error("Archive cursor filters and page size cannot change");
        if (chain.pages >= 6) throw new Error("Archive cursor page budget exhausted");
      } else {
        archiveInput(supplied);
        const limit = input.limit ?? 12;
        if (!Number.isInteger(limit) || limit < 1 || limit > 24)
          throw new Error("Archive page limit must be 1–24");
        await checkpoint();
        const order = supplied.oldestFirst === false ? "DESC" : "ASC";
        const rows = (
          await history.query(
            `SELECT ${columns} FROM messages m WHERE m.deleted_at IS NULL AND m.content IS NOT NULL AND m.thread_id IS NULL
          AND ($1::text IS NULL OR to_tsvector($7::regconfig,m.content) @@ websearch_to_tsquery($7::regconfig,$1))
          AND ($2::text[] IS NULL OR m.author_id=ANY($2)) AND ($3::text[] IS NULL OR m.channel_id=ANY($3))
          AND ($4::timestamptz IS NULL OR m.created_at >= $4) AND ($5::timestamptz IS NULL OR m.created_at < $5)
          ORDER BY m.created_at ${order},m.message_id::numeric ${order} LIMIT $6`,
            [
              supplied.query ?? null,
              supplied.authorIds ?? null,
              supplied.channelIds ?? null,
              supplied.after ?? null,
              supplied.before ?? null,
              6 * limit + 1,
              archiveDictionary(supplied),
            ],
          )
        ).rows;
        chain = {
          filters: supplied,
          limit,
          pages: 0,
          scanned: 0,
          last: null,
          snapshot: {
            selectedAt: new Date().toISOString(),
            mode: "frozen-index-identities-current-originals",
            workerLifetime: true,
          },
          rows: rows.slice(0, 6 * limit),
          overflow: rows.length > 6 * limit,
        };
      }
      const direction = chain.filters.oldestFirst === false ? -1 : 1;
      const candidates = chain.rows
        .filter((row) => !chain.last || direction * compare(tuple(row), chain.last) > 0)
        .slice(0, chain.limit);
      let sources = await fresh(candidates);
      const filters = chain.filters;
      sources = sources.filter(
        (source) =>
          (!filters.authorIds || filters.authorIds.includes(source.authorId)) &&
          (!filters.channelIds || filters.channelIds.includes(source.channelId)) &&
          (!filters.after || Date.parse(source.createdAt) >= Date.parse(filters.after)) &&
          (!filters.before || Date.parse(source.createdAt) < Date.parse(filters.before)),
      );
      const matches = await archiveMatches(history, sources, filters);
      if (matches)
        sources = sources.filter(
          (source) =>
            matches.get(source.id)?.[
              filters.matchMode === "stemmed" ? "stemmedMatch" : "lexicalMatch"
            ],
        );

      const last = candidates.length ? tuple(candidates.at(-1)) : chain.last;
      const remaining = chain.rows.filter(
        (row) => !last || direction * compare(tuple(row), last) > 0,
      ).length;
      const pages = chain.pages + 1,
        scanned = chain.scanned + candidates.length;
      const more = remaining > 0 && pages < 6;
      return {
        sources: sources.sort(
          (a, b) =>
            Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
            (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0),
        ),
        ...coverage,
        ...archiveRelevance,
        ...(filters.query
          ? {
              matchMode: filters.matchMode ?? "lexical",
              matchEvidence: Object.fromEntries(sources.map(({ id }) => [id, matches.get(id)])),
            }
          : {}),
        snapshot: chain.snapshot,
        filters,
        ordering: {
          pages: direction === 1 ? "oldest-first" : "newest-first",
          withinPage: "oldest-first",
          periodEndpoints: "traversal-order",
        },
        page: pages,
        scannedCandidates: candidates.length,
        totalScannedCandidates: scanned,
        scannedPeriod: candidates.length ? { from: tuple(candidates[0]), through: last } : null,
        selectedPeriod: chain.rows.length
          ? { from: tuple(chain.rows[0]), through: tuple(chain.rows.at(-1)) }
          : null,
        remainingSnapshotCandidates: remaining,
        exhausted: !remaining && !chain.overflow,
        stopReason: more ? "continue" : chain.overflow ? "chain-budget" : "archive-exhausted",
        remainingGap:
          more || chain.overflow
            ? {
                ...(direction === 1
                  ? { after: last, before: filters.before ?? null }
                  : { before: last, after: filters.after ?? null }),
                direction: direction === 1 ? "toward-newer" : "toward-older",
                reason: more
                  ? "snapshot-candidates-unread"
                  : "archive-beyond-chain-budget; start a separate bounded period",
              }
            : null,
        snapshotCaveat:
          "IDs/order are frozen, not historical content. Edits/deletions can omit matches; newly indexed messages require a new chain. Exhaustion covers these filters and index snapshot, not all history.",
        cursor: more ? pack({ ...chain, pages, scanned, last }) : null,
      };
    },
    async readDiscussion(input) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1 ||
        !snowflake(input.anchorId)
      )
        throw new Error("Supply one discussion anchorId");
      const found = await exact(input.anchorId);
      const gaps = [];
      if (!found.source)
        return {
          sources: [],
          anchorId: input.anchorId,
          ...coverage,
          gaps: [{ id: input.anchorId, reason: found.gap ?? "original-deleted-or-bot" }],
          completeDiscussion: false,
        };
      const anchor = found.source;
      const neighbors = (
        await history.query(
          `WITH earlier AS (SELECT ${columns} FROM messages m
        WHERE m.guild_id=$1 AND m.channel_id=$2 AND m.thread_id IS NULL AND m.deleted_at IS NULL AND m.content IS NOT NULL
        AND m.created_at >= $3::timestamptz-interval '30 minutes' AND (m.created_at,m.message_id::numeric)<($3::timestamptz,$4::numeric)
        ORDER BY m.created_at DESC,m.message_id::numeric DESC LIMIT 8),
        later AS (SELECT ${columns} FROM messages m
        WHERE m.guild_id=$1 AND m.channel_id=$2 AND m.thread_id IS NULL AND m.deleted_at IS NULL AND m.content IS NOT NULL
        AND m.created_at <= $3::timestamptz+interval '30 minutes' AND (m.created_at,m.message_id::numeric)>($3::timestamptz,$4::numeric)
        ORDER BY m.created_at,m.message_id::numeric LIMIT 8)
        SELECT * FROM earlier UNION ALL SELECT * FROM later`,
          [anchor.guildId, anchor.channelId, anchor.createdAt, anchor.id],
        )
      ).rows;
      const earlierCount = neighbors.filter(
        (row) =>
          compare(tuple(row), {
            at: new Date(anchor.createdAt).toISOString().replace("Z", "000Z"),
            id: anchor.id,
          }) < 0,
      ).length;
      const laterCount = neighbors.length - earlierCount;
      gaps.push({
        direction: "before",
        reason:
          earlierCount === 8
            ? "neighbor-limit; earlier-coverage-unknown"
            : "outside-30-minute-neighborhood-unscanned",
      });
      gaps.push({
        direction: "after",
        reason:
          laterCount === 8
            ? "neighbor-limit; later-coverage-unknown"
            : "outside-30-minute-neighborhood-unscanned",
      });
      const selected = new Map([[anchor.id, anchor]]),
        roles = { [anchor.id]: ["anchor"] };
      for (const source of await fresh(neighbors)) {
        selected.set(source.id, source);
        roles[source.id] = [
          source.replyTo === anchor.id ? "direct-reply-to-anchor" : "chronological-neighbor",
        ];
      }
      for (const neighbor of neighbors)
        if (!selected.has(neighbor.id))
          gaps.push({ id: neighbor.id, reason: "neighbor-original-deleted-or-bot" });
      const replyEdges = [],
        visited = new Set([anchor.id]);
      let child = anchor;
      for (let depth = 0; child.replyTo && depth < 6; depth++) {
        const parentId = child.replyTo;
        if (visited.has(parentId)) {
          gaps.push({ id: parentId, reason: "reply-cycle" });
          break;
        }
        visited.add(parentId);
        const parent = await exact(parentId);
        if (!parent.source) {
          selected.delete(parentId);
          delete roles[parentId];
          gaps.push({
            id: parentId,
            from: child.id,
            to: parentId,
            reason: parent.gap ?? "original-deleted-or-bot",
          });
          break;
        }
        selected.set(parentId, parent.source);
        roles[parentId] = [...new Set([...(roles[parentId] ?? []), "reply-ancestor"])];
        replyEdges.push({
          from: child.id,
          to: parentId,
          crossChannel: child.channelId !== parent.source.channelId,
        });
        child = parent.source;
        if (depth === 5 && child.replyTo)
          gaps.push({ id: child.replyTo, reason: "reply-depth-budget" });
      }
      const unavailableReferences = [],
        unexpandedReferences = [];
      const referenceGaps = new Map(
        gaps.filter((gap) => gap.id).map((gap) => [gap.id, gap.reason]),
      );
      for (const source of selected.values()) {
        if (!source.replyTo || selected.has(source.replyTo)) continue;
        const reason = referenceGaps.get(source.replyTo);
        const unavailable =
          reason && !["thread-excluded", "reply-depth-budget", "reply-cycle"].includes(reason);
        const edge = {
          from: source.id,
          to: source.replyTo,
          reason: reason ?? "not-expanded-within-bounds",
          contentKnown: false,
          referentKnown: false,
        };
        if (unavailable)
          unavailableReferences.push({ ...edge, availability: "unavailable-in-this-result" });
        else
          unexpandedReferences.push({
            ...edge,
            availability:
              reason === "thread-excluded"
                ? "excluded-thread"
                : "not-expanded; unavailability-not-established",
          });
      }
      return {
        sources: [...selected.values()].sort(
          (a, b) =>
            Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
            (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
        ),
        anchorId: anchor.id,
        roles,
        replyEdges,
        unavailableReferences,
        unexpandedReferences,
        referenceCaveat:
          "An unresolved reply ID does not establish the referenced text, image presence/content, joke target, topic or recipient. Nearby messages do not resolve that attribution. Not expanded means not checked, not proven unavailable; missing from the index does not prove deletion from Discord.",
        gaps,
        ...coverage,
        qualificationSearch: {
          filters: {
            channelIds: [anchor.channelId],
            after: new Date(Date.parse(anchor.createdAt) - 30 * 60_000).toISOString(),
            before: new Date(Date.parse(anchor.createdAt) + 30 * 60_000 + 1).toISOString(),
            oldestFirst: true,
          },
          guidance:
            "Browse this interval without query, optionally narrowed to the relevant authorIds, and continue its cursor. Qualifications can omit the topic words. This neighborhood is only a starting bound; inspect intervening periods between earlier and later claims before describing a change or its absence.",
        },
        neighborhood: {
          channelId: anchor.channelId,
          minutesEachSide: 30,
          maxEachSide: 8,
          candidates: neighbors.length,
        },
        completeDiscussion: false,
        caveat:
          "Neighbors are temporal context, not inferred thread membership. Other participants, replies, threads and messages beyond these bounds may be missing.",
      };
    },
  };
}
