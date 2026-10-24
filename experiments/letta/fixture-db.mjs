import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import pg from "pg";
import { root, saveJson, safeError, assertPrivateState } from "./runtime.mjs";

const exec = promisify(execFile);
const mode = process.argv[2];
if (!["fixtures", "live", "knowledge-review", "semantic-review"].includes(mode))
  throw new Error("Use fixtures, live, knowledge-review or semantic-review");
const bin = (name) =>
  process.env.MUDFUT_PG_BIN ? join(resolve(process.env.MUDFUT_PG_BIN), name) : name;
const version = await exec(bin("initdb"), ["--version"]);
if (!/PostgreSQL\) 16\./.test(version.stdout))
  throw new Error("PostgreSQL 16 binaries are required; set MUDFUT_PG_BIN");
const parent =
  mode === "live"
    ? resolve(
        process.env.MUDFUT_RUNS_DIR ?? join(homedir(), ".local", "state", "mudfut-letta", "proofs"),
      )
    : tmpdir();
assertPrivateState(parent);
await mkdir(parent, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(parent, "mudfut-" + mode + "-"));
const data = join(directory, "postgres");
const password = randomBytes(24).toString("hex");
const pwfile = join(directory, "pg-password");
let child;
const controller = new AbortController();
const interrupt = () => {
  controller.abort();
  child?.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

async function run(args) {
  if (controller.signal.aborted) throw new Error("Interrupted");
  await new Promise((accept, reject) => {
    child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, MUDFUT_STATE_DIR: directory, CHECK_DATABASE: "1" },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? accept()
        : reject(new Error(`Check failed (${signal ?? code}): ${args.join(" ")}`)),
    );
  });
  child = undefined;
}

try {
  await writeFile(pwfile, password, { mode: 0o600 });
  await exec(
    bin("initdb"),
    [
      "-D",
      data,
      "-U",
      "mudfut_fixture",
      "--auth=scram-sha-256",
      "--pwfile",
      pwfile,
      "--encoding=UTF8",
      "--no-locale",
    ],
    { signal: controller.signal },
  );
  // ponytail: reserve then release a loopback port; a competing bind fails startup
  // rather than contacting an existing database. Container allocation is the upgrade.
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const port = server.address().port;
  await new Promise((accept) => server.close(accept));
  await exec(
    bin("pg_ctl"),
    [
      "-D",
      data,
      "-l",
      join(directory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port} -k ''`,
      "-w",
      "start",
    ],
    { signal: controller.signal },
  );
  const config = {
    host: "127.0.0.1",
    port,
    user: "mudfut_fixture",
    password,
    database: "mudfut_fixture",
  };
  const admin = new pg.Client({ ...config, database: "postgres" });
  await admin.connect();
  try {
    await admin.query("CREATE DATABASE mudfut_fixture");
  } finally {
    await admin.end();
  }
  await saveJson(join(directory, "postgres.json"), config);
  console.log(`Disposable PostgreSQL 16 on loopback:${port}; ${mode} state: ${directory}`);
  if (mode === "fixtures")
    await run([
      "--test",
      "check.test.mjs",
      "reply-reference.test.mjs",
      "coverage-inspector.test.mjs",
      "configuration.test.mjs",
      "pilot-check.test.mjs",
      "security-check.test.mjs",
      "recovery-check.test.mjs",
      "history-check.test.mjs",
      "archive-recall.test.mjs",
      "history-automation.test.mjs",
      "history-retries.test.mjs",
      "live-priority.test.mjs",
      "memory-postgres.test.mjs",
      "chronology-check.test.mjs",
      "reply-path.test.mjs",
      "pilot-route.test.mjs",
      "reply-format.test.mjs",
      "operator-requests.test.mjs",
      "tool-lifecycle.test.mjs",
      "discussions.test.mjs",
      "search-gaps.test.mjs",
      "learning-metrics.test.mjs",
      "community-knowledge.test.mjs",
      "community-knowledge-manifest.test.mjs",
      "community-knowledge-review.test.mjs",
      "community-knowledge-review-package.test.mjs",
      "community-knowledge-offline-semantic-acceptance.test.mjs",
      "pilot-baseline-history.test.mjs",
      "pilot-baseline-snapshot.test.mjs",
      "history-annotation-recovery.matrix.test.mjs",
    ]);
  else if (mode === "knowledge-review")
    await run([
      "--test",
      "community-knowledge-review.test.mjs",
      "community-knowledge-review-package.test.mjs",
    ]);
  else if (mode === "semantic-review")
    await run(["--test", "community-knowledge-offline-semantic-acceptance.test.mjs"]);
  else {
    // Fresh state every invocation, real model calls, and a separate OS process
    // for every phase. Transcript checks run only after those executions succeed.
    for (const phase of ["learn", "recall", "sources", "continuity", "ambient", "spontaneous"])
      await run(["demo.mjs", phase]);
    await run(["transcript.mjs"]);
  }
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  // Only this run's cluster is ever stopped or deleted. A failed stop preserves
  // its directory for recovery instead of deleting data under a live server.
  let stopped = false;
  try {
    const status = await exec(bin("pg_ctl"), ["-D", data, "status"]).catch((e) => {
      if (e.code === 3 || e.code === 4) return null;
      throw e;
    });
    if (status) await exec(bin("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
    stopped = true;
  } catch (error) {
    console.error("Cluster cleanup failed: " + safeError(error));
    process.exitCode = 1;
  }
  if (stopped) {
    if (mode !== "live") await rm(directory, { recursive: true, force: true });
    else {
      await rm(data, { recursive: true, force: true });
      await rm(pwfile, { force: true });
      await rm(join(directory, "postgres.json"), { force: true });
    }
  }
  console.log(
    stopped
      ? "Disposable PostgreSQL stopped and removed."
      : `Cluster retained for recovery: ${data}`,
  );
  if (mode === "live")
    console.log(`Private model evidence retained: ${join(directory, "transcripts")}`);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
