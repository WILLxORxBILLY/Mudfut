import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import pg from "pg";
import { state } from "./runtime.mjs";
import { setTimeout as delay } from "node:timers/promises";
import {
  recoveryDecision,
  retryableFailure,
  boundedCleanup,
  resetAfterStableProgress,
} from "./pilot-supervisor.mjs";

async function until(read) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error("Recovery check timed out");
}
const json = async (path) => JSON.parse(await readFile(path, "utf8").catch(() => "null"));
const exited = (child) =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

test("cleanup completes on rejected closes and times out a stuck SDK close", async () => {
  const result = await boundedCleanup([Promise.resolve(), Promise.reject(new Error("closed"))]);
  assert.deepEqual(
    result.map((entry) => entry.status),
    ["fulfilled", "rejected"],
  );
  await assert.rejects(boundedCleanup([new Promise(() => {})], 10), /cleanup timed out/);
});

test("retry classification and a latched persisted budget distinguish outages from intervention", () => {
  for (const e of [
    { status: 503 },
    { code: "ECONNRESET" },
    { code: "57P01" },
    { retryable: true },
    new Error("fetch failed"),
  ])
    assert.ok(retryableFailure(e));
  for (const e of [
    { status: 401, retryable: true },
    { status: 403 },
    new Error("invalid_grant"),
    new Error("Invalid structured understanding"),
  ])
    assert.equal(retryableFailure(e), false);
  let state = { failures: [] };
  for (let i = 0; i < 5; i++) {
    state = recoveryDecision(state, { code: 75, signal: null }, 1000 + i * 3600000);
    assert.equal(state.held, i === 4);
  }
  assert.equal(recoveryDecision({ failures: [] }, { code: 78 }, 1000).held, true);
  assert.equal(
    recoveryDecision({ failures: [] }, { code: null, signal: "SIGKILL" }, 1000).held,
    false,
  );
});

test("only stable progress by the matching worker resets its persisted failure budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mudfut-stable-"));
  const previous = { failures: [1, 2], workerPid: 123, workerStartedAt: 1000 };
  try {
    assert.deepEqual(await resetAfterStableProgress(directory, previous), previous);
    for (const [pid, at] of [
      [999, 901001],
      [123, 900999],
    ]) {
      await writeFile(
        join(directory, "pilot-health.json"),
        JSON.stringify({ pid, at: new Date(at).toISOString() }),
      );
      assert.deepEqual(await resetAfterStableProgress(directory, previous), previous);
    }
    await writeFile(
      join(directory, "pilot-health.json"),
      JSON.stringify({ pid: 123, at: new Date(901000).toISOString() }),
    );
    assert.deepEqual((await resetAfterStableProgress(directory, previous)).failures, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "real supervisor/worker interruptions recover, stop cleanly, and retain a latched retry budget",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mudfut-supervisor-"));
    const supervisor = new URL("./pilot-supervisor.mjs", import.meta.url).href;
    const worker = join(directory, "worker.mjs"),
      wrapper = join(directory, "supervise.mjs");
    await writeFile(
      worker,
      `import {readFileSync,writeFileSync,renameSync} from 'node:fs';
const path=process.env.MUDFUT_STATE_DIR+'/attempt.json';
let old;try{old=JSON.parse(readFileSync(path))}catch(error){if(error.code!=='ENOENT')throw error;old={n:0}}
const n=old.n+1,temporary=path+'.'+process.pid+'.tmp';
writeFileSync(temporary,JSON.stringify({n,pid:process.pid}),{flag:'wx',mode:0o600});renameSync(temporary,path);
if(process.env.ALWAYS_FAIL==='1'||n<3) {
 process.exitCode=75;process.disconnect();
} else {
 process.on('disconnect',()=>process.exit(0));
 setInterval(()=>{},1000);
}
`,
    );
    await writeFile(
      wrapper,
      `import {supervise} from ${JSON.stringify(supervisor)};
await supervise({worker:${JSON.stringify(worker)},policy:{attempts:5,windowMs:900000,backoffMs:[10]},watchdogMs:60000});
`,
    );
    const start = (extra = {}) =>
      spawn(process.execPath, [wrapper], {
        env: { ...process.env, MUDFUT_STATE_DIR: directory, ...extra },
        stdio: "ignore",
      });
    let child;
    try {
      child = start();
      let completion = exited(child);
      const third = await until(async () => {
        const x = await json(join(directory, "attempt.json"));
        return x?.n === 3 && x;
      });
      process.kill(third.pid, "SIGKILL");
      await until(async () => (await json(join(directory, "attempt.json")))?.n === 4);
      child.kill("SIGKILL");
      assert.equal((await completion).signal, "SIGKILL");
      // The old worker exits on IPC disconnect, as the real pilot does.
      await delay(100);
      child = start();
      completion = exited(child);
      const fifth = await until(async () => {
        const x = await json(join(directory, "attempt.json"));
        return x?.n === 5 && x;
      });
      child.kill("SIGTERM");
      assert.equal((await completion).code, 0);
      assert.throws(() => process.kill(fifth.pid, 0), /ESRCH/);
      await writeFile(
        join(directory, "pilot-recovery.json"),
        JSON.stringify({ failures: [], held: false, running: false }),
      );
      child = start({ ALWAYS_FAIL: "1" });
      assert.equal((await exited(child)).code, 0);
      const held = await json(join(directory, "pilot-recovery.json"));
      assert.equal(held.held, true);
      assert.equal(held.failures.length, 5);
      const attempts = await json(join(directory, "attempt.json"));
      child = start();
      assert.equal((await exited(child)).code, 0);
      assert.deepEqual(await json(join(directory, "attempt.json")), attempts);
    } finally {
      child?.kill("SIGTERM");
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "SIGKILL preserves prepared memory and reconciles accepted delivery without a second send",
  { skip: process.env.CHECK_DATABASE !== "1", timeout: 30000 },
  async () => {
    const credentials = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
    assert.equal(credentials.user, "mudfut_fixture");
    const admin = new pg.Client(credentials);
    const directory = await mkdtemp(join(tmpdir(), "mudfut-crash-"));
    const database = "mudfut_fixture_crash";
    let db;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${database}`);
      const config = { ...credentials, database };
      await writeFile(join(directory, "postgres.json"), JSON.stringify(config), { mode: 0o600 });
      execFileSync("git", ["init", "--quiet", directory]);
      const worker = join(directory, "crash.mjs");
      await writeFile(
        worker,
        `
import pg from ${JSON.stringify(import.meta.resolve("pg"))};
import {readFile,writeFile} from 'node:fs/promises';
import {pilotStore,sourceRecord,deliver,emptyMemory} from ${JSON.stringify(new URL("./pilot-store.mjs", import.meta.url).href)};
import {memoryStore} from ${JSON.stringify(new URL("./memory.mjs", import.meta.url).href)};
const dir=process.env.MUDFUT_STATE_DIR;
const db=new pg.Client(JSON.parse(await readFile(dir+'/postgres.json','utf8')));await db.connect();
const config={guildId:'111111111111111111',channelId:'222222222222222222',historyScope:[]};
const store=await pilotStore(db,config),memory=memoryStore(dir),phase=process.argv[2];
const crash=()=>process.kill(process.pid,'SIGKILL');
const source=sourceRecord({id:'555555555555555501',channel_id:config.channelId,content:'Friday at seven',author:{id:'333333333333333333',username:'Member'},timestamp:'2026-10-15T17:00:00Z',type:0},config.guildId,config.channelId);
try {
if(phase==='prepare'){
 await store.ingest(source,true); const batch=await store.next();
 await store.prepare(0,batch,{content:emptyMemory+'Friday at seven',expectedRevision:(await memory.read()).revision},'Seven it is.');crash();
}else if(phase==='memory'){
 const work=(await db.query("SELECT candidate FROM pilot_work WHERE status='prepared'")).rows[0];
 await memory.write(work.candidate);crash();
}else{
 await store.finish(memory);
 const discord={after:async()=>JSON.parse(await readFile(dir+'/accepted.json','utf8').catch(()=> '[]')),
 send:async(_channel,body)=>{if(phase!=='send')throw new Error('Duplicate send attempted');
 await writeFile(dir+'/accepted.json',JSON.stringify([{id:'555555555555555599',author:{id:'bot'},message_reference:body.message_reference}]));crash();}};
 await deliver(store,discord,'bot',config.channelId,async()=>{});
}
}finally{await db.end();}
`,
      );
      const run = async (phase, signal = null) => {
        const child = spawn(process.execPath, [worker, phase], {
          env: { ...process.env, MUDFUT_STATE_DIR: directory },
          stdio: "pipe",
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const result = await exited(child);
        assert.deepEqual(result, { code: signal ? null : 0, signal }, stderr);
      };
      db = new pg.Client(config);
      await db.connect();
      await run("prepare", "SIGKILL");
      assert.equal((await db.query("SELECT status FROM pilot_work")).rows[0].status, "prepared");
      await run("memory", "SIGKILL");
      await run("send", "SIGKILL");
      assert.equal((await db.query("SELECT status FROM pilot_outbox")).rows[0].status, "sending");
      await run("recover");
      await run("recover");
      assert.equal((await db.query("SELECT status FROM pilot_outbox")).rows[0].status, "sent");
      assert.equal((await db.query("SELECT status FROM pilot_work")).rows[0].status, "done");
      assert.equal(JSON.parse(await readFile(join(directory, "accepted.json"), "utf8")).length, 1);
      assert.ok(
        execFileSync("git", ["-C", directory, "show", "HEAD:community.md"], {
          encoding: "utf8",
        }).endsWith("Friday at seven"),
      );
      // A missing acknowledgement with no matching remote reply stays held.
      await db.query("UPDATE pilot_outbox SET status='sending',discord_id=NULL");
      await writeFile(join(directory, "accepted.json"), "[]");
      await run("recover");
      assert.equal((await db.query("SELECT status FROM pilot_outbox")).rows[0].status, "held");
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
