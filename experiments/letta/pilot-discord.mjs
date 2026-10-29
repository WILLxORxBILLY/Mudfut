import { REST, Routes } from "discord.js";
import { sourceRecord, snowflake, digest, hasTextEvidence } from "./pilot-store.mjs";
import { setTimeout as delay } from "node:timers/promises";

function transientDiscordRead(error) {
  if (error?.status != null)
    return Number.isInteger(error.status) && error.status >= 500 && error.status <= 599;
  return [
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
  ].includes(error?.code);
}

// Only transport read exhaustion gets this marker; audit/storage failures propagate unchanged.
export class DiscordReadUnavailable extends Error {
  constructor(cause) {
    super(cause.message ?? "Discord read unavailable", { cause });
    this.name = "DiscordReadUnavailable";
    this.code = cause.code;
    this.status = cause.status;
  }
}

export async function retryRead(read, record = async () => {}, pause = delay) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (!transientDiscordRead(error)) throw error;
      if (attempt === 2) throw new DiscordReadUnavailable(error);
      await record({
        type: "discord_read_retry",
        attempt: attempt + 1,
        status: error.status ?? null,
        code: error.code ?? null,
      });
      await pause(250 * 4 ** attempt);
    }
  }
}

// Discord expires typing after ten seconds. Keep one request in flight at most.
export function startTyping(discord, channelId, record, timers = globalThis) {
  let busy = false;
  let stopped = false;
  async function ping() {
    if (busy || stopped) return;
    busy = true;
    try {
      await discord.typing(channelId);
      await record({ type: "discord_typing", channelId });
    } catch (error) {
      // Presence is best effort; it must never prevent a durable reply.
      await record({ type: "discord_typing_failed", status: error.status ?? null }).catch(() => {});
    } finally {
      busy = false;
    }
  }
  void ping();
  const timer = timers.setInterval(() => void ping(), 8000);
  timer.unref?.();
  return () => {
    stopped = true;
    timers.clearInterval(timer);
  };
}

// REST uses AbortError for its own request timeout. These GETs have no caller
// cancellation signal; keep retries bounded and leave ambiguous POSTs untouched.
export async function discordRead(read) {
  try {
    return await read();
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
    const timeout = new Error("Discord read timed out", { cause: error });
    timeout.code = "ETIMEDOUT";
    throw timeout;
  }
}

function exactDiscordOriginal(message, requestedId) {
  if (message != null && message.id !== requestedId)
    throw new Error("Discord source identity mismatch");
  return message;
}

export function discordTransport(token, record) {
  // Disable the REST library's automatic 5xx retry: a POST may have succeeded.
  // Its rate-limit scheduling remains enabled. Durable outbox owns send recovery.
  const rest = new REST({ version: "10", retries: 0, timeout: 30000 }).setToken(token);
  let serverTime;
  rest.on("response", (_request, response) => {
    const at = Date.parse(response.headers.get("date"));
    if (Number.isFinite(at)) serverTime = at;
  });
  const read = (route, options) =>
    retryRead(() => discordRead(() => rest.get(route, options)), record);
  async function after(channelId, afterId) {
    const result = [];
    let before;
    // Fetch backward from latest; Discord's `after` endpoint is not assumed to
    // return the oldest page. Thus a restart cannot skip a busy interval.
    for (let page = 0; page < 30; page++) {
      const query = new URLSearchParams({ limit: "100", ...(before ? { before } : {}) });
      const messages = await read(Routes.channelMessages(channelId), { query });
      result.push(...messages.filter((m) => BigInt(m.id) > BigInt(afterId)));
      if (messages.length < 100 || messages.some((m) => BigInt(m.id) <= BigInt(afterId)))
        return result.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      before = messages.reduce((a, b) => (BigInt(a.id) < BigInt(b.id) ? a : b)).id;
    }
    throw new Error("Discord catch-up exceeded 3000 messages; cursor retained for operator review");
  }
  return {
    me: () => read(Routes.user()),
    guildChannels: (guildId) => read(Routes.guildChannels(guildId)),
    serverTime: () => {
      if (!Number.isFinite(serverTime)) throw new Error("Discord server time unavailable");
      return serverTime;
    },
    activeThreads: (guildId) => read(Routes.guildActiveThreads(guildId)),
    channel: (id) => read(Routes.channel(id)),
    recent: (id, limit = 20) =>
      read(Routes.channelMessages(id), { query: new URLSearchParams({ limit: String(limit) }) }),
    around: (id, messageId) =>
      read(Routes.channelMessages(id), {
        query: new URLSearchParams({ limit: "100", around: messageId }),
      }),
    after,
    async get(channelId, messageId) {
      try {
        return exactDiscordOriginal(
          await read(Routes.channelMessage(channelId, messageId)),
          messageId,
        );
      } catch (error) {
        if (error.code === 10008) return null;
        throw error;
      }
    },
    async react(channelId, messageId, emojiName, emojiId) {
      const emoji = encodeURIComponent(`${emojiName}:${emojiId}`);
      const response = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${emoji}/@me`,
        {
          method: "PUT",
          headers: { Authorization: `Bot ${token}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) {
        const error = new Error("Discord acknowledgment failed");
        error.status = response.status;
        const retry = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retry) && retry >= 0) error.retryAfterMs = retry * 1000;
        throw error;
      }
    },
    typing: (channelId) => rest.post(Routes.channelTyping(channelId)),
    send: (channelId, body) => rest.post(Routes.channelMessages(channelId), { body }),
  };
}

function archiveDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    return false;
  const time = Date.parse(value);
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, ms = "") => `.${ms.padEnd(3, "0")}Z`);
  return Number.isFinite(time) && new Date(time).toISOString() === canonical;
}

export function archiveInput(input) {
  const keys = [
    "query",
    "messageId",
    "authorIds",
    "channelIds",
    "after",
    "before",
    "oldestFirst",
    "matchMode",
  ];
  const ids = (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    value.every(snowflake) &&
    new Set(value).size === value.length;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    (Object.hasOwn(input, "messageId") &&
      (!snowflake(input.messageId) || Object.keys(input).length !== 1)) ||
    (Object.hasOwn(input, "query") &&
      (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200)) ||
    ["authorIds", "channelIds"].some((key) => Object.hasOwn(input, key) && !ids(input[key])) ||
    ["after", "before"].some((key) => Object.hasOwn(input, key) && !archiveDate(input[key])) ||
    (input.after && input.before && Date.parse(input.after) >= Date.parse(input.before)) ||
    (Object.hasOwn(input, "oldestFirst") && typeof input.oldestFirst !== "boolean") ||
    (Object.hasOwn(input, "matchMode") &&
      (!input.query || !["lexical", "stemmed"].includes(input.matchMode))) ||
    !["messageId", "query", "authorIds", "channelIds", "after", "before"].some((key) =>
      Object.hasOwn(input, key),
    )
  )
    throw new Error(
      "Supply an exact message ID alone, or keywords/person/channel/date filters; dates must be valid UTC ISO timestamps",
    );
}

// PostgreSQL's simple dictionary keeps token boundaries/Unicode handling while
// avoiding English stems that can merge different concepts. Broader recall is
// explicit; neither dictionary establishes the meaning of a matching passage.
export const archiveDictionary = (input) => (input.matchMode === "stemmed" ? "english" : "simple");
export async function archiveMatches(db, sources, input) {
  if (!input.query || !sources.length) return null;
  const { rows } = await db.query(
    `SELECT x.id,
      to_tsvector('simple',x.content) @@ websearch_to_tsquery('simple',$2) AS "lexicalMatch",
      to_tsvector('english',x.content) @@ websearch_to_tsquery('english',$2) AS "stemmedMatch"
      FROM jsonb_to_recordset($1::jsonb) AS x(id text,content text)`,
    [JSON.stringify(sources.map(({ id, content }) => ({ id, content }))), input.query],
  );
  return new Map(rows.map(({ id, ...evidence }) => [id, evidence]));
}
export const archiveRelevance = {
  relevance:
    "Token matches are discovery candidates, not assessed topic relevance. Inspect the surrounding discussion; metaphors and interleaved topics may match literally.",
  coverage:
    "Only returned sources were inspected by this tool; keyword-missing qualifications, other discussions and unread pages remain unassessed. Exhaustion is filter-scoped, not topic completeness or proof of an unchanged view.",
};

export async function syncKnowledgeSource(knowledge, source) {
  if (hasTextEvidence(source)) await knowledge?.registerSource(source);
  else await knowledge?.removeSource(source.id);
}

export async function refreshSources(
  store,
  discord,
  record = async () => {},
  ids,
  checkpoint = async () => {},
  knowledge,
) {
  // Bounded background sweep; explicit IDs validate evidence used by a turn.
  const rows = await store.validationSources(ids);
  const currentRows = rows.filter((row) => !row.deleted);
  // An earlier crash can persist the pilot tombstone before the knowledge-side
  // invalidation. Explicit evidence validation sees those tombstones and repairs
  // the knowledge projection before any caller receives the old candidate.
  for (const row of rows.filter((row) => row.deleted)) {
    await knowledge?.removeSource(row.id);
    await record({ type: "source_mutation", kind: "deleted-reconciled", sourceId: row.id });
  }
  const currentById = await currentSources(
    discord,
    currentRows.map((row) => row.source),
    checkpoint,
  );
  for (const row of currentRows) {
    const source = row.source;
    const current = currentById.get(source.id);
    if (!current) {
      await store.remove(source.id);
      await knowledge?.removeSource(source.id);
      await record({ type: "source_mutation", kind: "deleted", sourceId: source.id });
    } else {
      const updated = sourceRecord(current, source.guildId, source.channelId);
      await store.ingest(updated, false, row.learnable);
      await syncKnowledgeSource(knowledge, updated);
      if (row.hash !== digest(JSON.stringify(updated)))
        await record({
          type: "source_mutation",
          kind: "edited",
          source: updated,
          previousHash: row.hash,
        });
    }
    await store.checked(source.id);
  }
}

export async function currentSources(discord, sources, checkpoint = async () => {}) {
  const channels = new Map();
  for (const source of sources) {
    if (!channels.has(source.channelId)) channels.set(source.channelId, []);
    channels.get(source.channelId).push(source);
  }
  const result = new Map();
  for (const [channelId, group] of channels) {
    // ponytail: one recent plus at most four historical pages per channel
    // reduces scattered exact reads. Every call starts fresh; a gateway mutation
    // feed is the upgrade if bounded cold-history validation remains expensive.
    let page = [];
    if (group.length > 1) {
      await checkpoint();
      page = await discord.recent(channelId, 100);
    }
    const found = new Map(page.map((message) => [message.id, message]));
    let missing = group
      .filter((source) => !found.has(source.id))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
    // Recenter on uncovered chronology; stop on no progress rather than repeating
    // an unhelpful page. Every still-uncovered ID gets its exact read below.
    for (let page = 0; page < 4 && missing.length > 1 && discord.around; page++) {
      await checkpoint();
      const older = await discord.around(channelId, missing[Math.floor(missing.length / 2)].id);
      for (const message of older) found.set(message.id, message);
      const remaining = missing.filter((source) => !found.has(source.id));
      if (remaining.length === missing.length) break;
      missing = remaining;
    }
    for (const source of group) {
      if (found.has(source.id)) result.set(source.id, found.get(source.id));
      else {
        await checkpoint();
        result.set(
          source.id,
          exactDiscordOriginal(await discord.get(channelId, source.id), source.id),
        );
      }
    }
  }
  return result;
}

export function archiveTool(store, discord, config, history) {
  return async (input) => {
    archiveInput(input);
    const parameters = [
      input.messageId ?? null,
      input.query ?? null,
      input.authorIds ?? null,
      input.channelIds ?? null,
      input.after ?? null,
      input.before ?? null,
      archiveDictionary(input),
    ];
    const order = input.oldestFirst ? "ASC" : "DESC";
    const local = await store.db.query(
      `SELECT source FROM pilot_sources s WHERE NOT s.deleted
      AND ($1::text IS NULL OR id=$1)
      AND ($2::text IS NULL OR to_tsvector($7::regconfig,source->>'content') @@ websearch_to_tsquery($7::regconfig,$2))
      AND ($3::text[] IS NULL OR source->>'authorId'=ANY($3))
      AND ($4::text[] IS NULL OR source->>'channelId'=ANY($4))
      AND ($5::timestamptz IS NULL OR (source->>'createdAt')::timestamptz >= $5)
      AND ($6::timestamptz IS NULL OR (source->>'createdAt')::timestamptz < $6)
      ORDER BY CASE WHEN $2::text IS NULL THEN 0 ELSE
        ts_rank_cd(to_tsvector($7::regconfig,source->>'content'),websearch_to_tsquery($7::regconfig,$2)) END DESC,
        id::numeric ${order} LIMIT 8`,
      parameters,
    );
    let archived = [];
    if (history) {
      // Read-only role AND read-only transaction. Legacy channel/opt-out settings
      // are retired; source freshness and provenance remain mandatory.
      await history.query("BEGIN READ ONLY");
      try {
        const result = await history.query(
          `SELECT m.message_id AS id,m.guild_id AS "guildId",m.channel_id AS "channelId"
          FROM messages m WHERE m.deleted_at IS NULL AND m.content IS NOT NULL
          AND ($1::text IS NULL OR m.message_id=$1)
          AND ($2::text IS NULL OR to_tsvector($7::regconfig,m.content) @@ websearch_to_tsquery($7::regconfig,$2))
          AND ($3::text[] IS NULL OR m.author_id=ANY($3))
          AND ($4::text[] IS NULL OR m.channel_id=ANY($4))
          AND ($5::timestamptz IS NULL OR m.created_at >= $5)
          AND ($6::timestamptz IS NULL OR m.created_at < $6)
          ORDER BY CASE WHEN $2::text IS NULL THEN 0 ELSE
            ts_rank_cd(to_tsvector($7::regconfig,m.content),websearch_to_tsquery($7::regconfig,$2)) END DESC,
            m.created_at ${order},m.message_id::numeric ${order} LIMIT 8`,
          parameters,
        );
        archived = result.rows;
        await history.query("COMMIT");
      } catch (error) {
        await history.query("ROLLBACK");
        throw error;
      }
    }
    // ponytail: interleave the independently ranked eight-result pools so cached
    // local hits cannot bury uncached archive evidence. Upgrade to reciprocal
    // rank fusion if more retrieval engines are added; this bounds REST reads to 16.
    const candidates = new Map();
    for (let index = 0; index < Math.max(archived.length, local.rows.length); index++)
      for (const candidate of [archived[index], local.rows[index]?.source])
        if (candidate && !candidates.has(candidate.id)) candidates.set(candidate.id, candidate);
    const result = [];
    for (const candidate of candidates.values()) {
      // The archive is a search index: only the current Discord original can be
      // quoted. Missing originals invalidate cached dependent understanding.
      const current = exactDiscordOriginal(
        await discord.get(candidate.channelId, candidate.id),
        candidate.id,
      );
      if (!current) {
        await store.remove(candidate.id);
        continue;
      }
      if (current.author?.bot || current.author?.id === config.botId) continue;
      const source = sourceRecord(current, candidate.guildId, candidate.channelId);
      await store.ingest(source, false, false);
      if (store.isHeld && (await store.isHeld(source.id))) continue;
      // An edited source may no longer match the selected person/channel/date.
      // Persist the edit first so dependent memory is invalidated even if omitted.
      if (
        (input.authorIds && !input.authorIds.includes(source.authorId)) ||
        (input.channelIds && !input.channelIds.includes(source.channelId)) ||
        (input.after && Date.parse(source.createdAt) < Date.parse(input.after)) ||
        (input.before && Date.parse(source.createdAt) >= Date.parse(input.before))
      )
        continue;
      result.push(source);
      if (result.length === 8) break;
    }
    const matches = await archiveMatches(store.db, result, input);
    const sources = matches
      ? result
          .filter(
            (source) =>
              matches.get(source.id)?.[
                input.matchMode === "stemmed" ? "stemmedMatch" : "lexicalMatch"
              ],
          )
          .slice(0, 8)
      : result.slice(0, 8);
    return {
      sources,
      authority: "PostgreSQL source records revalidated against Discord",
      ...(input.query
        ? {
            matchMode: input.matchMode ?? "lexical",
            matchEvidence: Object.fromEntries(sources.map(({ id }) => [id, matches.get(id)])),
          }
        : {}),
      ...archiveRelevance,
    };
  };
}
