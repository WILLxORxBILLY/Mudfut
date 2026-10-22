import { snowflake } from "./pilot-store.mjs";

const intervalKeys = ["guildId", "channelId", "after", "before", "fromId", "toId"];
const compare = (a, b) =>
  a.time - b.time || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
const interval = (from, to) => ({
  guildId: from.guildId,
  channelId: from.channelId,
  after: new Date(from.time).toISOString(),
  before: new Date(to.time).toISOString(),
  fromId: from.id,
  toId: to.id,
});

export function searchGapInvestigator({ findGap, inspectGap, now = Date.now, deadline }) {
  if (
    typeof findGap !== "function" ||
    typeof inspectGap !== "function" ||
    typeof now !== "function" ||
    !Number.isFinite(deadline)
  )
    throw new Error("Gap investigation requires callbacks and a finite turn deadline");
  const seen = new Map();
  let busy = false,
    spent = false,
    overflow = false;
  const registerSources = (sources) => {
    if (!Array.isArray(sources)) throw new Error("Gap anchors must be source records");
    for (const source of sources) {
      const time = Date.parse(source?.createdAt);
      if (
        !source ||
        ![source.id, source.guildId, source.channelId].every(snowflake) ||
        typeof source.createdAt !== "string" ||
        !Number.isFinite(time)
      )
        throw new Error("Invalid gap source identity or timestamp");
      const old = seen.get(source.id);
      if (
        old &&
        (old.guildId !== source.guildId || old.channelId !== source.channelId || old.time !== time)
      )
        throw new Error("Gap source identity changed");
      // ponytail: 512 anchors per turn bound sorting and unread-ID parameters.
      // Stop explicitly at the ceiling; interval-indexed coverage is the upgrade.
      if (!old && seen.size === 512) {
        overflow = true;
        continue;
      }
      seen.set(source.id, {
        id: source.id,
        guildId: source.guildId,
        channelId: source.channelId,
        time,
      });
    }
  };
  const check = async (candidates, inspect, selectionReason) => {
    if (busy)
      return { status: "in-progress", reason: "A chronological gap check is already running" };
    if (overflow)
      return {
        status: "anchor-budget-uninspected",
        reason: "The 512-anchor turn bound was reached; additional history remains unassessed",
      };
    if (!candidates.length)
      return {
        status: "no-potential-gap",
        reason:
          "No adjacent same-channel anchors within the 24-hour heuristic; other history remains unassessed",
      };
    if (deadline - now() < 20_000)
      return {
        status: "budget-uninspected",
        reason: "Less than 20 seconds remain in the original turn deadline",
        gap: candidates[0],
      };
    // Single-flight covers discovery too. A null index check never spends the
    // one actual probe; selected reasons are audit context, not source evidence.
    busy = true;
    try {
      const gap = await findGap(candidates, [...seen.keys()]);
      if (!gap)
        return {
          status: "no-indexed-gap",
          reason:
            "No unseen indexed messages in these bounded intervals; other history remains unassessed",
        };
      if (!candidates.some((candidate) => intervalKeys.every((key) => candidate[key] === gap[key])))
        throw new Error("Indexed gap is outside the supplied anchor intervals");
      const selected = selectionReason === undefined ? {} : { selectionReason };
      if (spent)
        return {
          status: "probe-budget-used",
          reason:
            "One bounded probe was attempted; continue this relevant interval with ordinary archive tools",
          gap,
          ...selected,
        };
      if (!inspect)
        return {
          status: "gap-uninspected",
          reason:
            "Indexed messages remain unread; assess relevance before selecting source anchors to investigate",
          gap,
        };
      if (deadline - now() < 20_000)
        return {
          status: "budget-uninspected",
          reason: "Less than 20 seconds remain in the original turn deadline",
          gap,
          ...selected,
        };
      spent = true;
      const inspection = await inspectGap(gap);
      registerSources(inspection.sources);
      return {
        status: "inspected",
        reason:
          "One bounded query-free chronological probe; topical relevance and remaining history need assessment",
        gap,
        inspection,
        ...selected,
      };
    } finally {
      busy = false;
    }
  };
  return {
    async observe(sources, { inspect = true } = {}) {
      if (typeof inspect !== "boolean") throw new Error("Gap inspection mode must be boolean");
      registerSources(sources);
      const groups = new Map();
      for (const source of seen.values()) {
        const key = source.guildId + ":" + source.channelId;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(source);
      }
      const intervals = [];
      for (const group of groups.values()) {
        group.sort(compare);
        for (let i = 1; i < group.length; i++) {
          const from = group[i - 1],
            to = group[i];
          // ponytail: adjacent anchors no more than 24 hours apart, then the
          // eight widest intervals, are discovery leads, not topic relevance.
          // A multi-day coverage planner is the upgrade; unprobed history stays unread.
          if (to.time - from.time <= 24 * 60 * 60_000) intervals.push(interval(from, to));
        }
      }
      intervals.sort(
        (a, b) =>
          Date.parse(b.before) -
            Date.parse(b.after) -
            (Date.parse(a.before) - Date.parse(a.after)) ||
          a.guildId.localeCompare(b.guildId) ||
          a.channelId.localeCompare(b.channelId) ||
          a.after.localeCompare(b.after) ||
          (BigInt(a.fromId) < BigInt(b.fromId) ? -1 : BigInt(a.fromId) > BigInt(b.fromId) ? 1 : 0),
      );
      return check(intervals.slice(0, 8), inspect);
    },
    async investigate(input) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !["fromId", "toId", "reason"].includes(key)) ||
        !snowflake(input.fromId) ||
        !snowflake(input.toId) ||
        input.fromId === input.toId ||
        typeof input.reason !== "string" ||
        !input.reason.trim() ||
        input.reason.length > 300
      )
        throw new Error(
          "Supply two distinct known source IDs and a 1–300 character relevance reason",
        );
      const pair = [seen.get(input.fromId), seen.get(input.toId)];
      if (pair.some((source) => !source))
        throw new Error("Gap anchors must be known fresh archive originals from this turn");
      pair.sort(compare);
      const [from, to] = pair;
      if (
        from.guildId !== to.guildId ||
        from.channelId !== to.channelId ||
        to.time - from.time > 24 * 60 * 60_000
      )
        throw new Error("Gap anchors must share a guild/channel and be at most 24 hours apart");
      return check([interval(from, to)], true, input.reason);
    },
  };
}
