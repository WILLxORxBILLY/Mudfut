import { readFile, readdir, mkdir, writeFile, link, unlink, lstat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { hasTextEvidence, snowflake, sourceRecord } from "./pilot-store.mjs";
import { currentSources } from "./pilot-discord.mjs";
import { historyFailures } from "./pilot-history-failures.mjs";

const keys = (x, allowed) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.keys(x).every((k) => allowed.includes(k));
const identifier = (x) => typeof x === "string" && /^[a-z0-9-]{1,64}$/.test(x);
export function validateHistoryPass(value, config) {
  if (
    !keys(value, ["id", "episodes"]) ||
    !identifier(value.id) ||
    !Array.isArray(value.episodes) ||
    !value.episodes.length ||
    value.episodes.length > 6
  )
    throw new Error("History pass requires an ID and 1–6 bounded episodes");
  const seen = new Set(),
    episodes = new Set();
  return {
    id: value.id,
    episodes: value.episodes.map((e) => {
      if (
        !keys(e, ["key", "label", "guildId", "channelId", "sourceIds", "contextIds"]) ||
        !identifier(e.key) ||
        episodes.has(e.key) ||
        typeof e.label !== "string" ||
        !e.label.trim() ||
        e.label.length > 160 ||
        !snowflake(e.guildId) ||
        !snowflake(e.channelId) ||
        !Array.isArray(e.sourceIds) ||
        !e.sourceIds.length ||
        e.sourceIds.length > 24 ||
        !Array.isArray(e.contextIds) ||
        e.contextIds.length > 8 ||
        ![...e.sourceIds, ...e.contextIds].every(snowflake) ||
        new Set([...e.sourceIds, ...e.contextIds]).size !==
          e.sourceIds.length + e.contextIds.length ||
        e.sourceIds.some((id, i) => seen.has(id) || (i && BigInt(id) <= BigInt(e.sourceIds[i - 1])))
      )
        throw new Error("Invalid or overlapping historical episode");
      episodes.add(e.key);
      e.sourceIds.forEach((id) => seen.add(id));
      return {
        key: e.key,
        label: e.label,
        guildId: e.guildId,
        channelId: e.channelId,
        sourceIds: e.sourceIds,
        contextIds: e.contextIds,
      };
    }),
  };
}

export function preserveHistoryMemory(initial, patch, audit) {
  const existing = new Set(initial.map((e) => e.key));
  if ((audit.removed ?? []).length || (audit.evicted ?? []).length)
    throw new Error(
      "Historical learning cannot remove unrelated understanding or evict memory; use explicit sourced consolidation",
    );
  for (const entry of patch.upsert)
    if (
      existing.has(entry.key) &&
      !(audit.transitions ?? []).some(
        (t) =>
          t.key === entry.key &&
          t.previous?.key === entry.key &&
          ["extend", "revise", "correct", "consolidate"].includes(t.action) &&
          t.reason &&
          t.sourceIds?.length,
      )
    )
      throw new Error(
        "Historical revision needs a validated chronological lineage transition; preserve existing memory otherwise",
      );
}

export function textBearingHistorySources(batch) {
  return [
    ...(batch.rows ?? []).map((row) => row.source),
    ...(batch.context?.surroundingMessages ?? []),
  ].filter(hasTextEvidence);
}

// Publish complete requests without replacing an existing pass or exposing partial JSON.
export async function stageHistoryRequest(directory, value, config) {
  const pass = validateHistoryPass(value, config);
  const requests = join(directory, "history-requests");
  await mkdir(requests, { recursive: true, mode: 0o700 });
  const destination = join(requests, `${pass.id}.json`);
  const temporary = join(requests, `.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(pass) + "\n", { flag: "wx", mode: 0o600 });
  try {
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (
        !(await lstat(destination)).isFile() ||
        JSON.stringify(
          validateHistoryPass(JSON.parse(await readFile(destination, "utf8")), config),
        ) !== JSON.stringify(pass)
      )
        throw new Error("Historical pass ID already names a different immutable selection");
    }
  } finally {
    await unlink(temporary);
  }
  return destination;
}

// This is shared by first-pass learning and durable-view replay: the archive
// establishes the bounded selection, while Discord establishes current source text.
export async function currentHistoryEpisode(
  discord,
  history,
  episode,
  shouldYield = async () => false,
) {
  if (!history) throw new Error("Historical learning requires the read-only real archive");
  await history.query("BEGIN READ ONLY");
  let eligible;
  try {
    eligible = new Set(
      (
        await history.query(
          `SELECT m.message_id FROM messages m
        WHERE m.guild_id=$1 AND m.channel_id=$2 AND m.message_id=ANY($3::text[])
        AND m.deleted_at IS NULL AND m.content IS NOT NULL AND m.thread_id IS NULL`,
          [episode.guildId, episode.channelId, [...episode.sourceIds, ...episode.contextIds]],
        )
      ).rows.map((row) => row.message_id),
    );
    await history.query("COMMIT");
  } catch (error) {
    await history.query("ROLLBACK");
    throw error;
  }
  const requested = [...episode.sourceIds, ...episode.contextIds]
    .filter((id) => eligible.has(id))
    .map((id) => ({ id, channelId: episode.channelId }));
  if (await shouldYield()) return null;
  let originals;
  try {
    originals = await currentSources(discord, requested, async () => {
      if (await shouldYield())
        throw Object.assign(new Error("Historical source loading yielded"), {
          code: "HISTORY_QUEUE_YIELD",
        });
    });
  } catch (error) {
    if (error.code === "HISTORY_QUEUE_YIELD") return null;
    throw error;
  }
  if (await shouldYield()) return null;
  const accepted = new Map();
  const excluded = [...episode.sourceIds, ...episode.contextIds]
    .filter((id) => !eligible.has(id))
    .map((id) => ({ id, reason: "ineligible in archive" }));
  for (const { id } of requested) {
    const message = originals.get(id);
    if (!message) {
      excluded.push({ id, reason: "deleted" });
      continue;
    }
    if (message.author.bot || ![0, 19].includes(message.type)) {
      excluded.push({ id, reason: "bot or system message" });
      continue;
    }
    if (message.id !== id) throw new Error("Historical source ID mismatch");
    accepted.set(id, sourceRecord(message, episode.guildId, episode.channelId));
  }
  const rows = episode.sourceIds
    .filter((id) => accepted.has(id))
    .map((id) => ({ id, source: accepted.get(id) }));
  const context = episode.contextIds
    .filter((id) => accepted.has(id))
    .map((id) => accepted.get(id))
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
    );
  return { rows, context, excluded, acceptedIds: new Set(accepted.keys()) };
}

export function historyQueue(store, discord, config, directory, record, history, options = {}) {
  const shouldYield = options.shouldYield ?? (async () => false);
  const failures = historyFailures(store, record, options);
  const automation = historyAutomation(store, history, directory, record, shouldYield, failures);
  const now = options.now ?? Date.now;
  const enrolled = new Set();
  let activeEpisode = null;
  const dueEpisode = async () =>
    (
      await store.db.query(
        `SELECT * FROM pilot_history_episodes
     WHERE status='queued' OR (status='retry' AND next_attempt_at <= $1::timestamptz)
     ORDER BY CASE WHEN (manifest->'sourceIds'->>0) ~ '^[0-9]{17,20}$'
       THEN (manifest->'sourceIds'->>0)::numeric END NULLS LAST,id LIMIT 1`,
        [new Date(now()).toISOString()],
      )
    ).rows[0];
  async function enroll() {
    let names;
    try {
      names = (await readdir(join(directory, "history-requests")))
        .filter((n) => /^[a-z0-9-]{1,64}\.json$/.test(n))
        .sort();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      names = [];
    }
    // ponytail: scan the small operator-admitted request directory on idle cycles;
    // use a durable request cursor if the number of bounded passes becomes large.
    const paths = [
      join(directory, "history-pass.json"),
      ...names.map((n) => join(directory, "history-requests", n)),
    ];
    let path, request, content;
    for (const candidate of paths) {
      if (enrolled.has(candidate)) continue;
      try {
        if (!(await lstat(candidate)).isFile())
          throw new Error("History request must be a regular file");
        content = await readFile(candidate, "utf8");
        if (await failures.rejected(candidate, content)) {
          enrolled.add(candidate);
          return true;
        }
        request = JSON.parse(content);
        path = candidate;
        break;
      } catch (error) {
        if (error.code === "ENOENT") continue;
        await failures.reject(candidate, content ?? "", error);
        enrolled.add(candidate);
        return true;
      }
    }
    if (!path) return false;
    try {
      const pass = validateHistoryPass(request, config);
      if (
        path !== join(directory, "history-pass.json") &&
        path !== join(directory, "history-requests", `${pass.id}.json`)
      )
        throw new Error("History request filename must match its immutable pass ID");
      await store.db.query(
        "INSERT INTO pilot_history_passes(id,manifest) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [pass.id, pass],
      );
      const savedPass = (
        await store.db.query("SELECT manifest FROM pilot_history_passes WHERE id=$1", [pass.id])
      ).rows[0].manifest;
      if (JSON.stringify(validateHistoryPass(savedPass, config)) !== JSON.stringify(pass))
        throw new Error("Historical pass ID already names a different immutable selection");
      // Only the existing worker holding the database advisory lock enrolls work.
      for (const episode of pass.episodes) {
        const id = `${pass.id}:${episode.key}`;
        await store.db.query(
          "INSERT INTO pilot_history_episodes(id,pass_id,manifest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [id, pass.id, episode],
        );
        const saved = (
          await store.db.query("SELECT manifest FROM pilot_history_episodes WHERE id=$1", [id])
        ).rows[0].manifest;
        const canonical = validateHistoryPass({ id: pass.id, episodes: [saved] }, config)
          .episodes[0];
        if (JSON.stringify(canonical) !== JSON.stringify(episode))
          throw new Error("Historical episode ID already names a different immutable selection");
      }
      enrolled.add(path);
    } catch (error) {
      await failures.reject(path, content, error);
      enrolled.add(path);
    }
    return true;
  }
  return {
    get activeEpisode() {
      return activeEpisode;
    },
    failEpisode: failures.fail,
    deferEpisode: failures.defer,
    deferCandidate: failures.deferCandidate,
    async next() {
      activeEpisode = null;
      if (await shouldYield()) return null;
      await failures.ready();
      // ponytail: intake at most eight immutable requests before automatic work;
      // a durable file cursor is the upgrade when larger request backlogs need prompt admission.
      for (let intake = 0; intake < 8; intake++) {
        if (intake && (await shouldYield())) return null;
        if (!(await enroll())) break;
      }
      let row = await dueEpisode();
      if (!row) {
        await automation.admit();
        row = await dueEpisode();
      }
      if (!row || (await shouldYield())) return null;
      activeEpisode = row.id;
      const e = validateHistoryPass({ id: row.pass_id, episodes: [row.manifest] }, config)
        .episodes[0];
      const loaded = await currentHistoryEpisode(discord, history, e, shouldYield);
      if (!loaded) return null;
      let { rows, context } = loaded;
      const { excluded, acceptedIds } = loaded;
      for (const source of [...rows.map((row) => row.source), ...context])
        await store.ingest(source, false, false);
      const held = new Set(
        store.isHeld
          ? await Promise.all(
              [...rows.map((row) => row.source), ...context].map(async (source) =>
                (await store.isHeld(source.id)) ? source.id : null,
              ),
            )
          : [],
      );
      held.delete(null);
      if (held.size) {
        rows = rows.filter((row) => !held.has(row.id));
        context = context.filter((source) => !held.has(source.id));
        held.forEach((id) => acceptedIds.delete(id));
        excluded.push(...[...held].map((id) => ({ id, reason: "open correction" })));
      }
      for (const item of excluded.filter((item) => item.reason === "deleted"))
        await store.remove(item.id);
      await store.db.query(
        "UPDATE pilot_history_episodes SET excluded=$2,context_ids=$3 WHERE id=$1",
        [row.id, JSON.stringify(excluded), context.map((s) => s.id)],
      );
      if (!rows.length) {
        await store.db.query("UPDATE pilot_history_episodes SET status='excluded' WHERE id=$1", [
          row.id,
        ]);
        await record({ type: "history_excluded", episodeId: row.id, excluded });
        return null;
      }
      await record({
        type: "history_episode",
        episodeId: row.id,
        label: e.label,
        sources: rows.map((r) => r.source),
        context,
        excluded,
      });
      return {
        rows,
        replyTo: null,
        historyEpisode: row.id,
        context: {
          surroundingMessages: context,
          historicalEpisode: {
            id: row.id,
            label: e.label,
            unresolvedReplyIds: [
              ...new Set(
                [...rows.map((r) => r.source), ...context]
                  .map((s) => s.replyTo)
                  .filter((id) => id && !acceptedIds.has(id)),
              ),
            ],
            note: "Dated historical conversation, with surrounding messages as context. Preserve speakers, chronology and uncertainty. Only messages are observation targets; surroundingMessages may support understanding but need no observation decisions. Notice useful relationships, shared experiences, recurring or episode-specific jokes, disagreements and changes of view; retain concrete attributed context without inventing durable traits. Retain useful understanding and consolidate related episodes with explicit sourced lineage. Distinguish an earlier view, a later change, a correction and a continuing disagreement; never treat an old plan as current or silently discard contrary evidence. This is quiet learning, never a public reply.",
          },
        },
      };
    },
  };
}

export function validateHistoryAutomation(value) {
  if (
    !keys(value, [
      "id",
      "enabled",
      "channels",
      "maxMessages",
      "windowMinutes",
      "cooldownSeconds",
    ]) ||
    !identifier(value.id) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.channels) ||
    !value.channels.length ||
    value.channels.length > 100 ||
    !Number.isInteger(value.maxMessages ?? 24) ||
    (value.maxMessages ?? 24) < 1 ||
    (value.maxMessages ?? 24) > 24 ||
    !Number.isInteger(value.windowMinutes ?? 30) ||
    (value.windowMinutes ?? 30) < 1 ||
    (value.windowMinutes ?? 30) > 45 ||
    !Number.isInteger(value.cooldownSeconds ?? 120) ||
    (value.cooldownSeconds ?? 120) < 0 ||
    (value.cooldownSeconds ?? 120) > 86400
  )
    throw new Error("Invalid historical automation configuration");
  const seen = new Set();
  const channels = value.channels.map((channel) => {
    if (
      !keys(channel, ["guildId", "channelId", "start", "end"]) ||
      !snowflake(channel.guildId) ||
      !snowflake(channel.channelId) ||
      typeof channel.start !== "string" ||
      !Number.isFinite(Date.parse(channel.start)) ||
      (channel.end != null &&
        (typeof channel.end !== "string" ||
          !Number.isFinite(Date.parse(channel.end)) ||
          Date.parse(channel.end) <= Date.parse(channel.start))) ||
      seen.has(channel.channelId)
    )
      throw new Error("Invalid historical automation channel or date range");
    seen.add(channel.channelId);
    return {
      guildId: channel.guildId,
      channelId: channel.channelId,
      start: new Date(channel.start).toISOString(),
      end: channel.end == null ? null : new Date(channel.end).toISOString(),
    };
  });
  return {
    id: value.id,
    enabled: value.enabled,
    channels,
    maxMessages: value.maxMessages ?? 24,
    windowMinutes: value.windowMinutes ?? 30,
    cooldownSeconds: value.cooldownSeconds ?? 120,
  };
}

// Select in chronology, including surrounding context, without exposing search hits as read.
// ponytail: the cursor follows archive chronology; late backfill before the cursor
// needs a new automation ID/range (completed targets are deduplicated). Continuous
// backfill needs an ingestion-arrival cursor plus chronological gap reconciliation.
export async function selectAutomaticHistoryWindow(history, channel, cursor, settings) {
  const candidates = (
    await history.query(
      `SELECT message_id,created_at FROM messages
       WHERE guild_id=$1 AND channel_id=$2 AND thread_id IS NULL
         AND deleted_at IS NULL AND content IS NOT NULL
         AND created_at >= $3::timestamptz AND created_at <= COALESCE($4::timestamptz,now())
         AND (created_at,message_id::numeric) > ($5::timestamptz,$6::numeric)
       ORDER BY created_at,message_id::numeric LIMIT $7`,
      [
        channel.guildId,
        channel.channelId,
        channel.start,
        channel.end,
        cursor.at,
        cursor.id,
        settings.maxMessages,
      ],
    )
  ).rows;
  if (!candidates.length) return { targets: [], contextIds: [], cursor };
  const targets = [];
  for (const candidate of candidates) {
    if (
      targets.length &&
      (new Date(candidate.created_at) - new Date(targets[0].created_at) >
        settings.windowMinutes * 60000 ||
        new Date(candidate.created_at) - new Date(targets.at(-1).created_at) > 15 * 60000)
    )
      break;
    targets.push(candidate);
  }
  const first = targets[0],
    last = targets.at(-1);
  const context = (
    await history.query(
      `SELECT message_id,created_at FROM (
         (SELECT message_id,created_at FROM messages
          WHERE guild_id=$1 AND channel_id=$2 AND thread_id IS NULL
            AND deleted_at IS NULL AND content IS NOT NULL
            AND (created_at,message_id::numeric) < ($3::timestamptz,$4::numeric)
          ORDER BY created_at DESC,message_id::numeric DESC LIMIT 4)
         UNION ALL
         (SELECT message_id,created_at FROM messages
          WHERE guild_id=$1 AND channel_id=$2 AND thread_id IS NULL
            AND deleted_at IS NULL AND content IS NOT NULL
            AND (created_at,message_id::numeric) > ($5::timestamptz,$6::numeric)
          ORDER BY created_at,message_id::numeric LIMIT 4)
       ) surrounding ORDER BY created_at,message_id::numeric`,
      [
        channel.guildId,
        channel.channelId,
        first.created_at,
        first.message_id,
        last.created_at,
        last.message_id,
      ],
    )
  ).rows;
  return {
    targets,
    contextIds: context.map((row) => row.message_id),
    cursor: { at: new Date(last.created_at).toISOString(), id: last.message_id },
  };
}

function historyAutomation(store, history, directory, record, shouldYield, failures) {
  let lastAttempt = 0,
    initialized = false;
  return {
    async admit() {
      if (!history || (await shouldYield())) return;
      const path = join(directory, "history-automation.json");
      let settings,
        content = "";
      try {
        if (!(await lstat(path)).isFile())
          throw new Error("Historical automation must be a regular file");
        content = await readFile(path, "utf8");
        if (await failures.rejected(path, content)) return;
        settings = validateHistoryAutomation(JSON.parse(content));
      } catch (error) {
        if (error.code === "ENOENT") return;
        await failures.reject(path, content, error);
        return;
      }
      if (!settings.enabled || Date.now() - lastAttempt < settings.cooldownSeconds * 1000) return;
      if (!initialized) {
        await store.db.query(`CREATE TABLE IF NOT EXISTS pilot_history_automation (
          id text PRIMARY KEY, manifest jsonb NOT NULL, cursor_at timestamptz NOT NULL,
          cursor_id text NOT NULL DEFAULT '0', exhausted boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT now())`);
        initialized = true;
      }
      for (const channel of settings.channels) {
        const id = `${settings.id}:${channel.channelId}`;
        // Selection shape is immutable; scheduling/cooldown can be adjusted without rewinding history.
        const manifest = {
          ...channel,
          maxMessages: settings.maxMessages,
          windowMinutes: settings.windowMinutes,
        };
        await store.db.query(
          "INSERT INTO pilot_history_automation(id,manifest,cursor_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [id, manifest, channel.start],
        );
        const saved = (
          await store.db.query("SELECT manifest FROM pilot_history_automation WHERE id=$1", [id])
        ).rows[0];
        if (Object.keys(manifest).some((key) => saved.manifest[key] !== manifest[key])) {
          await failures.reject(
            path,
            content,
            new Error(
              "Historical automation ID already names a different immutable range; use a new ID",
            ),
          );
          return;
        }
      }
      const ids = settings.channels.map((channel) => `${settings.id}:${channel.channelId}`);
      const cursor = (
        await store.db.query(
          "SELECT * FROM pilot_history_automation WHERE id=ANY($1::text[]) AND NOT exhausted ORDER BY updated_at,id LIMIT 1",
          [ids],
        )
      ).rows[0];
      if (!cursor || (await shouldYield())) return;
      lastAttempt = Date.now();
      const window = await selectAutomaticHistoryWindow(
        history,
        cursor.manifest,
        { at: cursor.cursor_at, id: cursor.cursor_id },
        settings,
      );
      if (await shouldYield()) return;
      const selectedIds = window.targets.map((row) => row.message_id);
      const done = new Set(
        (
          await store.db.query(
            "SELECT DISTINCT unnest(read_ids) AS id FROM pilot_history_episodes WHERE status='done' AND read_ids && $1::text[]",
            [selectedIds],
          )
        ).rows.map((row) => row.id),
      );
      const sourceIds = selectedIds.filter((id) => !done.has(id));
      const contextIds = [
        ...new Set([...window.contextIds, ...selectedIds.filter((id) => done.has(id))]),
      ]
        .filter((id) => !sourceIds.includes(id))
        .slice(0, 8);
      const id =
        "auto-" +
        createHash("sha256")
          .update(JSON.stringify([cursor.id, selectedIds]))
          .digest("hex")
          .slice(0, 40);
      const episode = sourceIds.length
        ? {
            key: "window",
            label: `Historical conversation ${new Date(window.targets[0].created_at).toISOString()}`,
            guildId: cursor.manifest.guildId,
            channelId: cursor.manifest.channelId,
            sourceIds,
            contextIds,
          }
        : null;
      const pass = episode ? validateHistoryPass({ id, episodes: [episode] }, {}) : null;
      if (await shouldYield()) return;
      // Cursor advancement and immutable queued work are one transaction. Only memory commit sets read_ids.
      await store.db.query("BEGIN");
      try {
        if (pass) {
          await store.db.query(
            "INSERT INTO pilot_history_passes(id,manifest) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [id, pass],
          );
          await store.db.query(
            "INSERT INTO pilot_history_episodes(id,pass_id,manifest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [`${id}:window`, id, episode],
          );
        }
        await store.db.query(
          "UPDATE pilot_history_automation SET cursor_at=$2,cursor_id=$3,exhausted=$4,updated_at=clock_timestamp() WHERE id=$1",
          [
            cursor.id,
            window.cursor.at,
            window.cursor.id,
            !selectedIds.length &&
              cursor.manifest.end != null &&
              Date.parse(cursor.manifest.end) <= Date.now(),
          ],
        );
        await store.db.query("COMMIT");
      } catch (error) {
        await store.db.query("ROLLBACK");
        throw error;
      }
      await record({
        type: "history_automation_admitted",
        automationId: cursor.id,
        episodeId: episode ? `${id}:window` : null,
        selectedIds,
        sourceIds,
        contextIds,
        alreadyReadIds: [...done].filter((id) => selectedIds.includes(id)),
        cursor: window.cursor,
        reviewed: false,
        exhausted:
          !selectedIds.length &&
          cursor.manifest.end != null &&
          Date.parse(cursor.manifest.end) <= Date.now(),
      });
    },
  };
}
