import { snowflake } from "./pilot-store.mjs";

export function validateAcknowledgment(value) {
  if (
    !value ||
    !snowflake(value.emojiId) ||
    !snowflake(value.sinceId) ||
    typeof value.emojiName !== "string" ||
    !/^[A-Za-z0-9_]{2,32}$/.test(value.emojiName)
  )
    throw new Error("Invalid acknowledgment emoji configuration");
  return value;
}

export function eligibleAcknowledgment(message, source, cursors, addressed) {
  return Boolean(
    addressed &&
    !message.author?.bot &&
    [0, 19].includes(message.type) &&
    cursors[source.channelId] &&
    !source.content.trimStart().startsWith("!knowledge"),
  );
}

// ponytail: one bounded serial reaction queue keeps reply processing independent;
// upgrade to a dedicated durable scheduler beyond 256 pending or 1,256 retained receipts.
export function acknowledgments({
  initial,
  save,
  react,
  record,
  now = Date.now,
  timers = globalThis,
}) {
  const valid = (item) =>
    item &&
    snowflake(item.id) &&
    snowflake(item.channelId) &&
    Number.isSafeInteger(item.createdAt) &&
    Number.isInteger(item.attempts) &&
    item.attempts >= 0 &&
    item.attempts <= 3 &&
    Number.isSafeInteger(item.nextAt) &&
    ["pending", "done", "failed"].includes(item.status);
  if (
    initial != null &&
    (initial.version !== 1 ||
      !Array.isArray(initial.items) ||
      initial.items.length > 1256 ||
      !initial.items.every(valid) ||
      (initial.blockedUntil !== undefined && !Number.isSafeInteger(initial.blockedUntil)) ||
      new Set(initial.items.map((item) => item.id)).size !== initial.items.length)
  )
    throw new Error("Invalid acknowledgment receipt; inspect before enabling reactions");
  const items = initial?.items.map((item) => ({ ...item })) ?? [];
  let blockedUntil = initial?.blockedUntil ?? 0;
  let chain = Promise.resolve(),
    timer,
    stopped = false;
  const log = (event) =>
    Promise.resolve()
      .then(() => record(event))
      .catch(() => {});
  const persist = () => save({ version: 1, blockedUntil, items });
  const serial = (operation) => {
    const result = chain.then(operation);
    chain = result.catch((error) =>
      log({ type: "acknowledgment_receipt_failed", code: error.code ?? null }),
    );
    return result;
  };
  const schedule = () => {
    if (stopped) return;
    if (timer) timers.clearTimeout(timer);
    timer = null;
    const pending = items.filter((item) => item.status === "pending");
    if (!pending.length) return;
    const wait = Math.min(
      2147483647,
      Math.max(0, Math.max(blockedUntil, Math.min(...pending.map((item) => item.nextAt))) - now()),
    );
    timer = timers.setTimeout(() => {
      timer = null;
      void serial(drain).catch(() => {});
    }, wait);
    timer.unref?.();
  };
  async function drain() {
    const item = items.find((entry) => entry.status === "pending" && entry.nextAt <= now());
    if (!item || stopped || now() < blockedUntil) {
      schedule();
      return;
    }
    if (now() - item.createdAt > 300000 || item.attempts >= 3) {
      item.status = "failed";
      await persist();
      await log({ type: "acknowledgment_expired", sourceId: item.id });
      schedule();
      return;
    }
    item.attempts++;
    // Persist the attempt before the idempotent PUT, so a crash cannot reset the budget.
    await persist();
    if (stopped) return;
    try {
      await react(item.channelId, item.id);
      item.status = "done";
      await log({ type: "acknowledgment_sent", sourceId: item.id, attempt: item.attempts });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : null;
      const retryable = status === 429 || status >= 500 || status === null;
      const retryAfter = Number(error?.retryAfterMs);
      item.status = retryable && item.attempts < 3 && !(retryAfter > 300000) ? "pending" : "failed";
      const retryMs = Math.max(
        1000,
        Math.min(300000, Number(error?.retryAfterMs) || 1000 * 4 ** (item.attempts - 1)),
      );
      item.nextAt = now() + retryMs;
      if (status === 429)
        blockedUntil = Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.ceil(now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : retryMs)),
        );
      await log({
        type: "acknowledgment_failed",
        sourceId: item.id,
        attempt: item.attempts,
        status,
        code: error?.code ?? null,
        retrying: item.status === "pending",
      });
    }
    await persist();
    schedule();
  }
  schedule();
  return {
    offer(source, serverTime, sinceId) {
      if (
        !snowflake(source?.id) ||
        !snowflake(source?.channelId) ||
        !snowflake(sinceId) ||
        !Number.isSafeInteger(serverTime) ||
        BigInt(source.id) <= BigInt(sinceId)
      )
        return;
      const created = Date.parse(source.createdAt);
      // ponytail: five-minute catch-up ceiling avoids old reactions after downtime;
      // use a gateway-backed arrival receipt to cover longer outages without backfill.
      // Discord's clock, not the local host clock, bounds this comparison.
      if (!Number.isFinite(created) || created > serverTime + 1000 || serverTime - created > 300000)
        return;
      // ponytail: a crash before this asynchronous receipt is saved can miss an
      // acknowledgment; transactionally enqueue with source ingestion to close that gap.
      void serial(async () => {
        if (stopped || items.some((item) => item.id === source.id)) return;
        for (let i = items.length - 1; i >= 0; i--)
          if (items[i].status !== "pending" && now() - items[i].createdAt > 86400000)
            items.splice(i, 1);
        if (
          items.filter((item) => item.status === "pending").length >= 256 ||
          items.length >= 1256
        ) {
          await log({ type: "acknowledgment_queue_full", sourceId: source.id });
          return;
        }
        items.push({
          id: source.id,
          channelId: source.channelId,
          createdAt: now(),
          attempts: 0,
          nextAt: now(),
          status: "pending",
        });
        await persist();
        schedule();
      }).catch(() => {});
    },
    stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
    },
  };
}
