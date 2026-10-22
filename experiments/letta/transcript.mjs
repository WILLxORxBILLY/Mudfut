import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { transcriptDir } from "./runtime.mjs";

const dir = transcriptDir;
const runs = await Promise.all(
  (await readdir(dir))
    .filter((f) => f.endsWith(".jsonl"))
    .map(async (file) => ({
      file,
      events: (await readFile(join(dir, file), "utf8")).trim().split("\n").map(JSON.parse),
    })),
);
runs.sort((a, b) => a.events[0].at.localeCompare(b.events[0].at));
const completed = (phase) =>
  runs.find((r) => r.events.some((e) => e.type === "finish" && e.phase === phase));
const start = (run) => run.events.find((e) => e.type === "start");
const answers = (run) =>
  run.events
    .filter((e) => e.type === "sdk_event" && e.event.type === "result")
    .map((e) => e.event.result)
    .join("\n");
const phases = ["learn", "recall", "sources", "continuity", "ambient", "spontaneous"];
const successful = phases.map((phase) => {
  const run = completed(phase);
  assert.ok(run, `${phase} completed`);
  return run;
});
assert.equal(new Set(successful.map((r) => start(r).agentId)).size, 1);
assert.equal(new Set(successful.map((r) => start(r).pid)).size, phases.length);
for (const phase of ["recall", "spontaneous"]) {
  const run = completed(phase);
  assert.notEqual(start(run).conversationId, start(completed("learn")).conversationId);
  assert.ok(!start(run).tools.includes("search_archive"));
  assert.ok(run.events.some((e) => e.type === "application_tool" && e.name === "read_memory"));
}
const learn = completed("learn").events;
const firstWrite = learn.findIndex(
  (e) => e.type === "application_tool" && e.name === "update_memory",
);
assert.ok(
  firstWrite >= 0 && firstWrite < learn.findIndex((e) => e.type === "input" && e.kind === "direct"),
);
const correctionStart = learn.findIndex((e) => e.type === "input" && e.kind === "correction");
const correctionEnd = learn.findIndex((e) => e.type === "input" && e.kind === "continuity_setup");
const corrected = learn
  .slice(correctionStart, correctionEnd)
  .find((e) => e.type === "application_tool" && e.name === "update_memory");
assert.ok(corrected, "correction committed a revised memory");
assert.notEqual(corrected.result.commit, learn[firstWrite].result.commit);
assert.match(corrected.result.content, /demo-107/);
assert.match(corrected.result.content, /supply van/i);
assert.equal(
  start(completed("continuity")).conversationId,
  start(completed("learn")).conversationId,
);
assert.match(answers(completed("recall")), /supply van/i);
assert.match(answers(completed("continuity")), /Copper Badger/);
assert.match(answers(completed("spontaneous")), /ten/);
assert.match(answers(completed("spontaneous")), /Admiral Wrongway/);
assert.ok(
  !completed("ambient").events.some(
    (e) => e.type === "sdk_event" && e.event.type === "tool_result" && e.event.isError,
  ),
);
const sources = completed("sources");
for (const id of ["demo-104", "demo-105", "demo-106", "demo-107"]) {
  const row = sources.events
    .filter((e) => e.type === "application_tool" && e.name === "search_archive")
    .flatMap((e) => e.result.sources)
    .find((s) => s.message_id === id);
  assert.ok(row, `retrieved ${id}`);
  assert.ok(answers(sources).includes(row.content), `exact quote ${id}`);
}
const text = [
  `ACTUAL LOCAL LETTA TRANSCRIPT — ${runs[0].events[0].at}`,
  "Real subscription model calls and PostgreSQL tools. People and source records are fictional fixtures.",
  "Each phase ran in a separate OS process. Reasoning omitted; replies and application tool results retained.",
  "Ambient acknowledgements are internal terminal output. No Discord messages were sent.",
  "",
];
for (const run of runs) {
  text.push(`===== ${run.file} =====`);
  for (const e of run.events) {
    if (e.type === "start") text.push(JSON.stringify(e, null, 2));
    if (e.type === "input") text.push(`\nINPUT (${e.kind})\n${e.content}`);
    if (e.type === "application_tool")
      text.push(
        `\nAPPLICATION TOOL: ${e.name}\nInput: ${JSON.stringify(e.input)}\nResult: ${JSON.stringify(e.result, null, 2)}`,
      );
    if (e.type === "sdk_event" && e.event.type === "tool_result" && e.event.isError)
      text.push(`\nTOOL FAILURE: ${e.event.content}`);
    if (e.type === "sdk_event" && e.event.type === "result")
      text.push(`\nMUDFÜT (success=${e.event.success}):\n${e.event.result}`);
    if (e.type === "failure") text.push(`\nRUN FAILURE: ${e.error}`);
    if (e.type === "finish") text.push(`\nFINAL MEMORY REVISION: ${e.memory.revision}`);
  }
  text.push("");
}
const path = join(dir, "actual-transcript.txt");
await writeFile(path, text.join("\n"), { mode: 0o600 });
console.log(
  "Transcript checks passed: six separate processes, same agent, ambient writes, corrected recall, exact PostgreSQL quotes, original conversation resume, spontaneous recall.",
);
console.log(path);
