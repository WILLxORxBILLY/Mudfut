export class HistoryPreempted extends Error {
  constructor(messages) {
    super("Historical work yielded to a live conversation");
    this.name = "HistoryPreempted";
    this.code = "HISTORY_PREEMPTED";
    this.messages = messages;
  }
}

// ponytail: checkpoint polls reuse success for at most intervalMs; a gateway
// arrival feed is the upgrade if polling cadence cannot meet live priority needs.
function boundedLivePoll(poll, intervalMs, now) {
  if (
    typeof poll !== "function" ||
    typeof now !== "function" ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 1
  )
    throw new Error("Live polling needs a poll, clock and positive interval");
  let inFlight,
    messages,
    completedAt = -Infinity;
  return async ({ fresh = false } = {}) => {
    if (inFlight) return inFlight;
    const age = now() - completedAt;
    if (!fresh && age >= 0 && age < intervalMs) return messages;
    // A failed forced refresh must not make an earlier successful result reusable.
    completedAt = -Infinity;
    inFlight = Promise.resolve()
      .then(poll)
      .then((result) => {
        messages = result;
        completedAt = now();
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

// Source-loading loops can use this between network calls without creating a second writer.
export function livePriorityCheckpoint({ poll, isUrgent, intervalMs = 1500, now = Date.now }) {
  return boundedLivePoll(
    async () => {
      const messages = await poll();
      if (await isUrgent(messages)) throw new HistoryPreempted(messages);
      return messages;
    },
    intervalMs,
    now,
  );
}

export async function withLivePriority(
  action,
  {
    poll,
    isUrgent,
    abort,
    record = async () => {},
    intervalMs = 1500,
    now = Date.now,
    timers = { setTimeout, clearTimeout },
  },
) {
  if (
    typeof action !== "function" ||
    typeof poll !== "function" ||
    typeof isUrgent !== "function" ||
    typeof abort !== "function" ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 1
  )
    throw new Error(
      "Live priority requires an action, poll, urgency check, abort and positive interval",
    );
  const read = boundedLivePoll(poll, intervalMs, now);
  let stopped = false,
    timer,
    inFlight,
    failure;
  async function interrupt(error) {
    if (failure) return;
    failure = error;
    try {
      await record({
        type: error.code === "HISTORY_PREEMPTED" ? "history_preempted" : "history_priority_failure",
        code: error.code,
        incomingIds: error.messages?.map((message) => message.id) ?? [],
      });
    } catch (recordError) {
      error.recordError = recordError;
    }
    try {
      await abort(error);
    } catch (abortError) {
      error.abortError = abortError;
    }
  }
  async function check(options) {
    if (failure) throw failure;
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const messages = await read(options);
          if (await isUrgent(messages)) await interrupt(new HistoryPreempted(messages));
          return messages;
        } catch (cause) {
          const error = new Error("Live-priority polling failed; historical work was stopped", {
            cause,
          });
          error.code = "LIVE_PRIORITY_POLL_FAILED";
          await interrupt(error);
        }
      })().finally(() => {
        inFlight = null;
      });
    }
    const messages = await inFlight;
    if (failure) throw failure;
    return messages;
  }
  function schedule() {
    if (stopped || failure) return;
    timer = timers.setTimeout(() => {
      timer = null;
      // check records the failure and aborts the action; the caller receives it after action cleanup.
      void check()
        .catch(() => {})
        .finally(schedule);
    }, intervalMs);
  }
  // Start exactly one action. Polling can cancel it, but a replacement starts only after it settles.
  const running = Promise.resolve().then(() => action(check));
  const firstPoll = check();
  void firstPoll.catch(() => {}).finally(schedule);
  let result, actionError;
  try {
    result = await running;
  } catch (error) {
    actionError = error;
  } finally {
    stopped = true;
    if (timer != null) timers.clearTimeout(timer);
    // A live arrival already being fetched must be considered before accepting historical output.
    await inFlight?.catch(() => {});
    // Acceptance always observes a poll started after the action and prior poll drain.
    if (!actionError && !failure) await check({ fresh: true }).catch(() => {});
  }
  if (failure) {
    if (actionError && actionError !== failure) failure.actionError = actionError;
    throw failure;
  }
  if (actionError) throw actionError;
  return result;
}

// Health reports successful worker progress, not semantic learning or a completed read receipt.
export function progressPulse(save, { now = Date.now, minIntervalMs = 5000 } = {}) {
  if (
    typeof save !== "function" ||
    typeof now !== "function" ||
    !Number.isInteger(minIntervalMs) ||
    minIntervalMs < 5000
  )
    throw new Error("Progress pulse needs a saver, clock and interval of at least five seconds");
  let lastSaved = -Infinity,
    inFlight;
  return async (progress) => {
    const at = now();
    if (!Number.isFinite(at)) throw new Error("Invalid progress clock");
    if (inFlight) return inFlight;
    if (at >= lastSaved && at - lastSaved < minIntervalMs) return false;
    inFlight = Promise.resolve()
      .then(() => save({ at: new Date(at).toISOString(), progress }))
      .then(() => {
        lastSaved = at;
        return true;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
