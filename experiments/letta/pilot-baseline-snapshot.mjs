import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { archiveInput } from "./pilot-discord.mjs";
import { decodeUnderstanding, encodeUnderstanding } from "./pilot-memory.mjs";
import { digest, snowflake } from "./pilot-store.mjs";

const sourceFiles = [
  "bo-food-plan.sources.json",
  "domestic-work.earlier-context.json",
  "domestic-work.sources.json",
  "fisher-rangers.sources.json",
  "sports-idleness.sources.json",
  "suburban-families.sources.json",
];

const sourceLike = (value) =>
  value &&
  typeof value === "object" &&
  typeof (value.message_id ?? value.id) === "string" &&
  typeof (value.guild_id ?? value.guildId) === "string" &&
  typeof (value.channel_id ?? value.channelId) === "string" &&
  typeof (value.author_id ?? value.authorId) === "string" &&
  typeof value.content === "string" &&
  typeof (value.created_at ?? value.createdAt) === "string";

function toSource(row) {
  const id = row.message_id ?? row.id;
  const guildId = row.guild_id ?? row.guildId;
  const channelId = row.channel_id ?? row.channelId;
  const authorId = row.author_id ?? row.authorId;
  const createdAt = row.created_at ?? row.createdAt;
  if (
    !snowflake(id) ||
    !snowflake(guildId) ||
    !snowflake(channelId) ||
    !snowflake(authorId) ||
    !Number.isFinite(Date.parse(createdAt))
  )
    throw new Error(`Invalid stored-corpus source ${id ?? "(missing ID)"}`);
  return {
    id,
    guildId,
    channelId,
    authorId,
    authorName: row.author_display_name ?? row.authorName ?? "Unknown member",
    content: row.content,
    createdAt,
    editedAt: row.edited_at ?? row.editedAt ?? null,
    replyTo: row.reply_to_message_id ?? row.replyTo ?? null,
    url: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
  };
}

function collectSources(value, target) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSources(item, target));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (sourceLike(value)) target.set(String(value.message_id ?? value.id), toSource(value));
  Object.values(value).forEach((item) => collectSources(item, target));
}

const ordered = (sources, oldestFirst = true) =>
  [...sources].sort((a, b) => {
    const time = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (time) return oldestFirst ? time : -time;
    const ids = BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
    return oldestFirst ? ids : -ids;
  });

const words = (value) => value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
const queryGroups = (query) =>
  query
    .split(/\s+OR\s+/i)
    .map(words)
    .filter((group) => group.length);

// ponytail: this replay corpus uses a small literal-token matcher rather than the
// production PostgreSQL dictionaries. Add a captured tsvector/query result when
// evaluating lexical-vs-stemmed behavior rather than treating this as equivalent.
function matchesQuery(source, query) {
  if (!query) return true;
  const haystack = new Set(words(`${source.authorName} ${source.content}`));
  return queryGroups(query).some((group) => group.every((word) => haystack.has(word)));
}

function select(sources, input) {
  return ordered(
    sources.filter(
      (source) =>
        (!input.messageId || source.id === input.messageId) &&
        (!input.query || matchesQuery(source, input.query)) &&
        (!input.authorIds || input.authorIds.includes(source.authorId)) &&
        (!input.channelIds || input.channelIds.includes(source.channelId)) &&
        (!input.after || Date.parse(source.createdAt) >= Date.parse(input.after)) &&
        (!input.before || Date.parse(source.createdAt) < Date.parse(input.before)),
    ),
    input.oldestFirst !== false,
  );
}

const authority =
  "Stored private corpus replay: supplied read-only source packets, not freshly validated Discord originals.";

export async function loadBaseline(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "MANIFEST.json"), "utf8"));
  if (!manifest?.files || typeof manifest.files !== "object")
    throw new Error("Baseline manifest is invalid");
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (!/^[a-f0-9]{64}$/.test(expected))
      throw new Error(`Invalid baseline manifest hash: ${file}`);
    const actual = createHash("sha256")
      .update(await readFile(join(directory, file)))
      .digest("hex");
    if (actual !== expected) throw new Error(`Baseline manifest checksum mismatch: ${file}`);
  }
  const cases = JSON.parse(await readFile(join(directory, "cases.json"), "utf8"));
  if (!Array.isArray(cases.cases) || cases.cases.some((item) => typeof item?.id !== "string"))
    throw new Error("Baseline cases are invalid");
  const memory = JSON.parse(
    await readFile(join(directory, "memory-before-selection.json"), "utf8"),
  );
  if (
    !memory?.row ||
    typeof memory.row.content !== "string" ||
    !/^[a-f0-9]{64}$/.test(memory.row.revision ?? "") ||
    digest(memory.row.content) !== memory.row.revision
  )
    throw new Error("Baseline memory snapshot checksum mismatch");
  const sourceMap = new Map();
  const packetDigests = {};
  for (const file of sourceFiles) {
    const bytes = await readFile(join(directory, file));
    packetDigests[file] = createHash("sha256").update(bytes).digest("hex");
    const packet = JSON.parse(bytes);
    if (packet.truncated || (packet.unresolvedParentIds && packet.unresolvedParentIds.length))
      throw new Error(`Prepared source packet is incomplete: ${file}`);
    collectSources(packet, sourceMap);
  }
  return {
    cases: cases.cases.map(({ id, prompt }) => ({ id, prompt })),
    memory: { content: memory.row.content, revision: memory.row.revision },
    sources: ordered(sourceMap.values()),
    sourceMap,
    packetDigests,
  };
}

export function snapshotArchive(sources) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const cursors = new Map();
  const cursorLifetimeMs = 15 * 60_000;
  const pageLimit = 6;
  const trimCursors = () => {
    const now = Date.now();
    for (const [cursor, entry] of cursors) if (entry.expiresAt <= now) cursors.delete(cursor);
    while (cursors.size > 64) cursors.delete(cursors.keys().next().value);
  };
  const resultCoverage = {
    authority,
    corpusCoverage:
      "Only the prepared packet windows are searchable. An absent result is not evidence the Discord archive lacks it.",
    sourceFreshness: "No live Discord validation was attempted during this replay.",
  };
  const validateBrowse = (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid snapshot archive browsing options");
    const allowed = new Set([
      "query",
      "authorIds",
      "channelIds",
      "after",
      "before",
      "oldestFirst",
      "matchMode",
      "limit",
      "cursor",
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw new Error("Invalid snapshot archive browsing options");
    if (
      input.cursor !== undefined &&
      (typeof input.cursor !== "string" || input.cursor.length > 128)
    )
      throw new Error("Invalid snapshot archive cursor");
    if (input.cursor === undefined) {
      const filters = Object.fromEntries(
        ["query", "authorIds", "channelIds", "after", "before", "oldestFirst", "matchMode"]
          .filter((key) => Object.hasOwn(input, key))
          .map((key) => [key, input[key]]),
      );
      archiveInput(filters);
    }
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 24)
    )
      throw new Error("Snapshot archive page limit must be 1–24");
  };
  const page = (input) => {
    validateBrowse(input);
    trimCursors();
    let chain;
    if (input.cursor) {
      chain = cursors.get(input.cursor);
      if (!chain)
        throw new Error("Snapshot archive cursor expired or is unknown; start a new chain");
      if (
        Object.keys(input).some(
          (key) =>
            key !== "cursor" && JSON.stringify(input[key]) !== JSON.stringify(chain.filters[key]),
        )
      )
        throw new Error("Snapshot archive cursor filters and page size cannot change");
    } else {
      const filters = Object.fromEntries(
        ["query", "authorIds", "channelIds", "after", "before", "oldestFirst", "matchMode"]
          .filter((key) => Object.hasOwn(input, key))
          .map((key) => [key, input[key]]),
      );
      chain = {
        filters,
        limit: input.limit ?? 12,
        rows: select(sources, filters),
        offset: 0,
        pages: 0,
      };
    }
    if (chain.pages >= pageLimit) throw new Error("Snapshot archive page budget exhausted");
    const candidates = chain.rows.slice(chain.offset, chain.offset + chain.limit);
    const next = { ...chain, offset: chain.offset + candidates.length, pages: chain.pages + 1 };
    const more = next.offset < next.rows.length && next.pages < pageLimit;
    let cursor = null;
    if (more) {
      cursor = randomUUID();
      cursors.set(cursor, { ...next, expiresAt: Date.now() + cursorLifetimeMs });
    }
    return {
      sources: ordered(candidates),
      ...resultCoverage,
      filters: chain.filters,
      page: next.pages,
      scannedCandidates: candidates.length,
      totalScannedCandidates: next.offset,
      remainingSnapshotCandidates: Math.max(0, next.rows.length - next.offset),
      exhausted: next.offset >= next.rows.length,
      stopReason: more
        ? "continue"
        : next.offset < next.rows.length
          ? "chain-budget"
          : "corpus-exhausted",
      cursor,
    };
  };
  return {
    sourceLookup(ids) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
        throw new Error("Invalid stored-corpus source lookup");
      const found = ids.map((id) => byId.get(id));
      const missing = ids.filter((_, index) => !found[index]);
      if (missing.length)
        throw new Error(
          `Stored replay lacks evidence source(s): ${missing.slice(0, 8).join(", ")}`,
        );
      return found;
    },
    async search(input) {
      archiveInput(input);
      const matches = select(sources, input).slice(0, 8);
      return {
        sources: matches,
        ...resultCoverage,
        ...(input.query
          ? {
              matchMode: input.matchMode ?? "lexical",
              matchEvidence: Object.fromEntries(
                matches.map((source) => [source.id, { snapshotLiteralMatch: true }]),
              ),
            }
          : {}),
      };
    },
    async browseArchive(input) {
      return page(input);
    },
    async readDiscussion(input) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1
      )
        throw new Error("Supply one discussion anchorId");
      const { anchorId } = input;
      if (!snowflake(anchorId)) throw new Error("Supply one discussion anchorId");
      const anchor = byId.get(anchorId);
      if (!anchor)
        return {
          sources: [],
          anchorId,
          ...resultCoverage,
          gaps: [{ id: anchorId, reason: "not-in-prepared-corpus" }],
          completeDiscussion: false,
        };
      const sameChannel = ordered(
        sources.filter(
          (source) =>
            source.channelId === anchor.channelId &&
            source.id !== anchor.id &&
            Math.abs(Date.parse(source.createdAt) - Date.parse(anchor.createdAt)) <= 30 * 60_000,
        ),
      );
      const earlier = sameChannel
        .filter((source) => Date.parse(source.createdAt) < Date.parse(anchor.createdAt))
        .slice(-8);
      const later = sameChannel
        .filter((source) => Date.parse(source.createdAt) >= Date.parse(anchor.createdAt))
        .slice(0, 8);
      const selected = new Map([
        [anchor.id, anchor],
        ...earlier.map((source) => [source.id, source]),
        ...later.map((source) => [source.id, source]),
      ]);
      const roles = { [anchor.id]: ["anchor"] };
      for (const source of [...earlier, ...later])
        roles[source.id] = [
          source.replyTo === anchor.id ? "direct-reply-to-anchor" : "chronological-neighbor",
        ];
      const gaps = [
        {
          direction: "before",
          reason: earlier.length === 8 ? "neighbor-limit" : "outside-packet-window",
        },
        {
          direction: "after",
          reason: later.length === 8 ? "neighbor-limit" : "outside-packet-window",
        },
      ];
      let child = anchor;
      for (let depth = 0; child.replyTo && depth < 6; depth++) {
        const parent = byId.get(child.replyTo);
        if (!parent) {
          gaps.push({ id: child.replyTo, from: child.id, reason: "not-in-prepared-corpus" });
          break;
        }
        selected.set(parent.id, parent);
        roles[parent.id] = [...new Set([...(roles[parent.id] ?? []), "reply-ancestor"])];
        child = parent;
      }
      return {
        sources: ordered(selected.values()),
        anchorId,
        roles,
        gaps,
        ...resultCoverage,
        completeDiscussion: false,
        caveat:
          "Packet proximity is bounded context, not proof of complete Discord discussion coverage.",
      };
    },
    async findChronologicalGap(intervals, knownIds) {
      if (!Array.isArray(intervals) || !Array.isArray(knownIds))
        throw new Error("Invalid gap request");
      for (const interval of intervals) {
        const unread = sources.filter(
          (source) =>
            source.channelId === interval.channelId &&
            !knownIds.includes(source.id) &&
            Date.parse(source.createdAt) >= Date.parse(interval.after) &&
            Date.parse(source.createdAt) <= Date.parse(interval.before),
        );
        if (unread.length)
          return { ...interval, unreadCountCapped: Math.min(unread.length, 25), authority };
      }
      return null;
    },
  };
}

export async function isolatedMemory(directory, initial, availableSources) {
  if (!availableSources || typeof availableSources.has !== "function")
    throw new Error("Stored replay needs an available-source set");
  let current = { ...initial };
  const readable = (content) => {
    const entries = decodeUnderstanding(content);
    if (!entries) throw new Error("Stored replay memory is not version 2 understanding");
    // ponytail: replay source validation limits readable memory to entries with
    // available originals; live Discord validation is the upgrade. The full
    // 1,644-entry baseline remains on disk and on every write.
    return encodeUnderstanding(
      entries.filter((entry) =>
        entry.evidence.every((item) => availableSources.has(item.messageId)),
      ),
    );
  };
  const persist = async (name, value) => {
    const path = join(directory, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await persist("memory-before.json", current);
  await persist("memory-after.json", current);
  return {
    async read() {
      const content = readable(current.content);
      return { content, revision: digest(content) };
    },
    async write({ content, expectedRevision }) {
      const before = await this.read();
      if (typeof content !== "string" || expectedRevision !== before.revision)
        throw new Error("Stored replay memory revision changed unexpectedly");
      const returned = decodeUnderstanding(content);
      const all = decodeUnderstanding(current.content);
      if (!returned || !all) throw new Error("Stored replay memory is not version 2 understanding");
      if (
        returned.some((entry) =>
          entry.evidence.some((item) => !availableSources.has(item.messageId)),
        )
      )
        throw new Error("Stored replay memory update cites a source outside the fixed corpus");
      const readableKeys = new Set(decodeUnderstanding(before.content).map((entry) => entry.key));
      current = {
        content: encodeUnderstanding([
          ...all.filter((entry) => !readableKeys.has(entry.key)),
          ...returned,
        ]),
      };
      current.revision = digest(current.content);
      await persist("memory-after.json", current);
      return { ...current, storage: "isolated stored-corpus replay" };
    },
    async full() {
      return { ...current };
    },
  };
}
