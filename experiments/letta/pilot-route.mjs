import { readFile, lstat, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertPrivateState, saveJson, state } from "./runtime.mjs";
import { snowflake, validateScope, replyChannels } from "./pilot-store.mjs";

async function privateJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error(`${path} must be a private regular file`);
  return JSON.parse(await readFile(path, "utf8"));
}

export function routeSwitchPlan({ config, meta, outbox, work }, target) {
  const current = validateScope(config);
  if (replyChannels(current).length > 1)
    throw new Error("Single-route switch cannot replace a multi-channel installation");
  if (!snowflake(target?.guildId) || !snowflake(target?.channelId))
    throw new Error("Invalid replacement pilot route");
  if (meta?.scope?.guildId !== current.guildId || meta?.scope?.channelId !== current.channelId)
    throw new Error("Private route configuration differs from durable pilot scope");
  const unsafeOutbox = outbox.filter((row) => row.status !== "sent");
  const unsafeWork = work.filter((row) => row.status === "prepared");
  if (unsafeOutbox.length || unsafeWork.length)
    throw new Error("Route switch requires no unsent outbox or prepared memory work");
  return {
    previous: { guildId: current.guildId, channelId: current.channelId },
    next: { guildId: target.guildId, channelId: target.channelId },
    changed: current.guildId !== target.guildId || current.channelId !== target.channelId,
    config: {
      ...current,
      guildId: target.guildId,
      channelId: target.channelId,
      ...(current.replyChannelIds ? { replyChannelIds: [target.channelId] } : {}),
    },
  };
}

export function routeSwitchReport({ previous, next, changed, config }) {
  return { previous, next, changed, historyScopeCount: config.historyScope.length };
}

async function dumpDatabase(connection, destination) {
  await mkdir(join(state, "route-backups"), { recursive: true, mode: 0o700 });
  await new Promise((resolve, reject) => {
    const child = spawn(
      "pg_dump",
      [
        "--format=custom",
        "--file",
        destination,
        "--host",
        connection.host,
        "--port",
        String(connection.port ?? 5432),
        "--username",
        connection.user,
        connection.database,
      ],
      {
        env: { ...process.env, PGPASSWORD: connection.password },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Private PostgreSQL backup failed: ${stderr.trim()}`)),
    );
  });
}

export async function runRouteCommand(command, target) {
  if (!["plan", "switch"].includes(command)) throw new Error("Invalid route command");
  assertPrivateState(state);
  const configPath = join(state, "pilot.json");
  const config = validateScope(await privateJson(configPath));
  const connection = await privateJson(join(state, "postgres.json"));
  const db = new pg.Client(connection);
  await db.connect();
  let ownsWorkerLock = false;
  try {
    if (command === "switch") {
      ownsWorkerLock = (await db.query("SELECT pg_try_advisory_lock(1560387,1127029) AS acquired"))
        .rows[0].acquired;
      if (!ownsWorkerLock) throw new Error("Stop the active pilot worker before switching routes");
    }
    const [meta, outbox, work] = await Promise.all([
      db.query("SELECT scope,cursor,epoch FROM pilot_meta"),
      db.query(
        "SELECT status,count(*)::int AS count FROM pilot_outbox GROUP BY status ORDER BY status",
      ),
      db.query(
        "SELECT status,count(*)::int AS count FROM pilot_work GROUP BY status ORDER BY status",
      ),
    ]);
    const report = routeSwitchPlan(
      { config, meta: meta.rows[0], outbox: outbox.rows, work: work.rows },
      target ?? config,
    );
    if (command === "plan") {
      return {
        status: "safe-to-switch",
        ...routeSwitchReport(report),
        outbox: outbox.rows,
        work: work.rows,
      };
    }
    if (!report.changed) {
      return { status: "already-routed", ...routeSwitchReport(report) };
    }
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const backup = join(state, "route-backups", `pilot-before-route-${stamp}-${randomUUID()}.dump`);
    await dumpDatabase(connection, backup);
    await saveJson(join(state, `route-switch-${stamp}.json`), {
      previous: report.previous,
      next: report.next,
      databaseBackup: backup,
      cursorWasCleared: true,
      outbox: outbox.rows,
      work: work.rows,
    });
    await db.query("BEGIN");
    try {
      const locked = (await db.query("SELECT scope FROM pilot_meta WHERE id FOR UPDATE")).rows[0];
      routeSwitchPlan({ config, meta: locked, outbox: outbox.rows, work: work.rows }, report.next);
      await db.query(
        "ALTER TABLE pilot_meta ADD COLUMN IF NOT EXISTS cursors jsonb NOT NULL DEFAULT '{}'",
      );
      await db.query(
        `UPDATE pilot_meta SET cursors='{}',scope=$1,cursor=NULL,epoch=epoch+1,rebuild=false,relearning=false,
         invalid_sources='{}'`,
        [report.config],
      );
      await db.query(
        `UPDATE pilot_sources SET learnable=false,learned=true,addressed=false
         WHERE source->>'guildId'<>$1 OR source->>'channelId'<>$2`,
        [report.next.guildId, report.next.channelId],
      );
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    }
    await saveJson(configPath, report.config);
    return { status: "switched", ...routeSwitchReport(report), databaseBackup: backup };
  } finally {
    if (ownsWorkerLock)
      await db.query("SELECT pg_advisory_unlock(1560387,1127029)").catch(() => {});
    await db.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, guildId, channelId] = process.argv.slice(2);
  if (
    !["plan", "switch"].includes(command) ||
    Boolean(guildId) !== Boolean(channelId) ||
    (guildId !== undefined && (!snowflake(guildId) || !snowflake(channelId))) ||
    (command === "switch" && guildId === undefined)
  )
    throw new Error("Use plan [guild-id channel-id], or switch <guild-id> <channel-id>");
  console.log(
    JSON.stringify(
      await runRouteCommand(command, guildId === undefined ? undefined : { guildId, channelId }),
    ),
  );
}
