import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { state, root, assertPrivateState, saveJson, safeError } from "./runtime.mjs";
import { record } from "./pilot-model.mjs";

export const recoveryPolicy = {
  attempts: 5,
  windowMs: 15 * 60000,
  backoffMs: [2000, 5000, 15000, 30000, 60000],
};
export function boundedCleanup(cleanups, timeoutMs = 20000) {
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Worker cleanup timed out")), timeoutMs);
    Promise.allSettled(cleanups).then((results) => {
      clearTimeout(timer);
      accept(results);
    });
  });
}
export function retryableFailure(error) {
  const status = error?.status ?? error?.statusCode;
  const message = safeError(error);
  if (
    [401, 403].includes(status) ||
    /invalid.grant|unauthorized|forbidden|invalid.*credential|refresh.token.*(expired|revoked)/i.test(
      message,
    )
  )
    return false;
  return (
    error?.retryable === true ||
    [408, 429].includes(status) ||
    status >= 500 ||
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
      "57P01",
      "57P02",
      "57P03",
      "08006",
      "08003",
    ].includes(error?.code) ||
    /timed? ?out|timeout|fetch failed|socket|connection (terminated|closed)|temporar|overloaded|\b(429|500|502|503|504)\b/i.test(
      message,
    ) ||
    Boolean(error?.cause && retryableFailure(error.cause))
  );
}
export function recoveryDecision(previous, exit, now = Date.now(), policy = recoveryPolicy) {
  // Slow failures must not age out and permit an endless sequence of hangs.
  // Only demonstrated stable progress (or explicit operator resume) resets this.
  const failures = [...(previous.failures ?? []), now];
  const held =
    exit.code === 78 ||
    (exit.code !== 0 && exit.code !== 75 && !exit.signal) ||
    failures.length >= policy.attempts;
  return {
    failures,
    held,
    running: false,
    lastExit: exit,
    nextAttemptAt: held
      ? null
      : now + policy.backoffMs[Math.min(failures.length - 1, policy.backoffMs.length - 1)],
  };
}
export async function resetAfterStableProgress(directory, recovery, policy = recoveryPolicy) {
  let health;
  try {
    health = JSON.parse(await readFile(join(directory, "pilot-health.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return recovery;
    throw error;
  }
  return health.pid === recovery.workerPid &&
    Number.isFinite(recovery.workerStartedAt) &&
    Date.parse(health.at) - recovery.workerStartedAt >= policy.windowMs
    ? { ...recovery, failures: [] }
    : recovery;
}
export async function readRecovery(directory) {
  try {
    return JSON.parse(await readFile(join(directory, "pilot-recovery.json"), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { failures: [], held: false, running: false };
    throw e;
  }
}

export async function supervise({
  directory = state,
  worker = join(root, "pilot.mjs"),
  args = ["run"],
  policy = recoveryPolicy,
  watchdogMs = 240000,
} = {}) {
  assertPrivateState(directory);
  const path = join(directory, "pilot-recovery.json");
  let recovery = await readRecovery(directory);
  // ponytail: one Mini worker. PostgreSQL owns exclusivity; launchd owns this
  // supervisor. A persisted circuit breaker survives supervisor/machine restarts.
  if (recovery.running) {
    recovery = await resetAfterStableProgress(directory, recovery, policy);
    recovery = recoveryDecision(
      recovery,
      { code: null, signal: "SUPERVISOR_INTERRUPTED" },
      Date.now(),
      policy,
    );
  }
  let stopping = false,
    child,
    killTimer;
  const controller = new AbortController();
  const killGroup = (signal, target = child) => {
    if (!target?.pid) return;
    try {
      process.kill(-target.pid, signal);
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  };
  const stop = () => {
    stopping = true;
    controller.abort();
    killGroup("SIGTERM");
    killTimer ??= setTimeout(() => killGroup("SIGKILL"), 20000);
    killTimer.unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      await saveJson(path, recovery);
      if (recovery.held) {
        await record({ type: "recovery_held", ...recovery });
        return; // Successful supervisor exit stops launchd's crash restart policy.
      }
      const wait = Math.max(0, (recovery.nextAttemptAt ?? 0) - Date.now());
      if (wait) await delay(wait, undefined, { signal: controller.signal });
      if (stopping) break;
      recovery = {
        ...recovery,
        running: true,
        nextAttemptAt: null,
        workerPid: null,
        workerStartedAt: null,
      };
      await saveJson(path, recovery);
      const started = Date.now();
      child = spawn(process.execPath, [worker, ...args], {
        detached: true,
        cwd: resolve(root, "../.."),
        env: { ...process.env, MUDFUT_STATE_DIR: directory, MUDFUT_AUTH_MODE: "letta" },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const completion = new Promise((accept) => {
        child.once("error", (e) => accept({ code: 78, signal: null, error: safeError(e) }));
        child.once("exit", (code, signal) => accept({ code, signal }));
      });
      recovery = { ...recovery, workerPid: child.pid, workerStartedAt: started };
      await saveJson(path, recovery);
      await record({
        type: "worker_spawned",
        workerPid: child.pid,
        attempt: recovery.failures.length + 1,
      });
      const workerChild = child;
      let checking = false,
        finished = false,
        watchdogKill;
      const watchdog = setInterval(
        async () => {
          if (checking || stopping || finished || watchdogKill) return;
          checking = true;
          try {
            let last = started;
            try {
              const health = JSON.parse(
                await readFile(join(directory, "pilot-health.json"), "utf8"),
              );
              if (health.pid === workerChild.pid) last = Date.parse(health.at);
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
            if (!finished && (!Number.isFinite(last) || Date.now() - last > watchdogMs)) {
              await record({ type: "worker_watchdog", workerPid: workerChild.pid });
              if (!finished) {
                killGroup("SIGTERM", workerChild);
                watchdogKill = setTimeout(() => killGroup("SIGKILL", workerChild), 20000);
              }
            }
          } catch (e) {
            await record({ type: "watchdog_failure", error: safeError(e) }).catch(() => {});
          } finally {
            checking = false;
          }
        },
        Math.min(10000, watchdogMs),
      );
      let exit;
      try {
        exit = await completion;
      } finally {
        finished = true;
        clearInterval(watchdog);
        clearTimeout(watchdogKill);
        killGroup("SIGKILL"); // Reap orphaned SDK descendants after worker exit.
        child = undefined;
      }
      if (stopping) break;
      recovery = await resetAfterStableProgress(directory, recovery, policy);
      recovery = recoveryDecision(recovery, exit, Date.now(), policy);
      await saveJson(path, recovery);
      await record({ type: "worker_exit", ...recovery });
    }
  } catch (e) {
    if (!stopping) throw e;
  } finally {
    killGroup("SIGKILL");
    clearTimeout(killTimer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (stopping) await saveJson(path, { ...recovery, running: false, nextAttemptAt: null });
    await rm(join(directory, "supervisor-process.json"), { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    await saveJson(join(state, "supervisor-process.json"), {
      pid: process.pid,
      at: new Date().toISOString(),
    });
    await supervise();
  } catch (error) {
    await record({ type: "supervisor_blocked", error: safeError(error) }).catch(() => {});
    console.error(safeError(error));
    // Permanent configuration/storage errors must not create a launchd retry storm.
    process.exitCode = 0;
  }
}
