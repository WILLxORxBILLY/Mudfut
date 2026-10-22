// Private fixed-case baseline. It replays stored source packets only and never
// creates a Discord sender, a shared source store, or an operator queue record.
import { mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { isAbsolute, join, resolve } from "node:path";

const exec = promisify(execFile);
const packetDirectoryInput = process.env.MUDFUT_BASELINE_DIR;
const runDirectoryInput = process.env.MUDFUT_BASELINE_RUN_DIR;
const historyReaderInput = process.env.MUDFUT_HISTORY_READER_FILE;
const evaluationCasesInput = process.env.MUDFUT_EVALUATION_CASES_FILE;
const packetDirectory = resolve(packetDirectoryInput ?? "");
const runDirectory = resolve(runDirectoryInput ?? "");
const caseId = process.argv[2];
if (
  !packetDirectoryInput ||
  !isAbsolute(packetDirectoryInput) ||
  !runDirectoryInput ||
  !isAbsolute(runDirectoryInput)
)
  throw new Error(
    "Set absolute MUDFUT_BASELINE_DIR and MUDFUT_BASELINE_RUN_DIR outside the repository",
  );
if (!/^[a-z0-9-]+$/.test(caseId ?? "")) throw new Error("Pass one prepared baseline case ID");
for (const [name, value] of [
  ["MUDFUT_HISTORY_READER_FILE", historyReaderInput],
  ["MUDFUT_EVALUATION_CASES_FILE", evaluationCasesInput],
])
  if (value && !isAbsolute(value)) throw new Error(`Set absolute ${name} outside the repository`);
process.env.MUDFUT_STATE_DIR = join(runDirectory, "cases", caseId);

function privateQuestions(bytes) {
  const data = JSON.parse(bytes);
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).some((key) => !["version", "cases"].includes(key)) ||
    !Array.isArray(data.cases) ||
    !data.cases.length ||
    data.cases.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).some((key) => !["id", "prompt"].includes(key)) ||
        !/^[a-z0-9-]+$/.test(item.id) ||
        typeof item.prompt !== "string" ||
        !item.prompt.trim() ||
        item.prompt.length > 4000,
    ) ||
    new Set(data.cases.map((item) => item.id)).size !== data.cases.length
  )
    throw new Error("Private evaluation questions must contain unique id/prompt cases only");
  return data.cases.map(({ id, prompt }) => ({ id, prompt }));
}

function historyConfig(bytes) {
  const config = JSON.parse(bytes);
  if (
    !config ||
    typeof config !== "object" ||
    !["127.0.0.1", "::1", "localhost"].includes(config.host) ||
    config.user !== "mudfut_history_reader"
  )
    throw new Error(
      "Historical evaluation requires the configured loopback read-only history reader",
    );
  return config;
}

const [{ assertPrivateState, state, saveJson, safeError }, { pilotModel, record }, snapshot] =
  await Promise.all([
    import("./runtime.mjs"),
    import("./pilot-model.mjs"),
    import("./pilot-baseline-snapshot.mjs"),
  ]);

assertPrivateState(packetDirectory);
assertPrivateState(runDirectory);
assertPrivateState(state);
if (historyReaderInput) assertPrivateState(historyReaderInput);
if (evaluationCasesInput) assertPrivateState(evaluationCasesInput);
const baseline = await snapshot.loadBaseline(packetDirectory);
const evaluationInput = evaluationCasesInput
  ? await readFile(evaluationCasesInput).then((bytes) => ({
      cases: privateQuestions(bytes),
      digest: createHash("sha256").update(bytes).digest("hex"),
      kind: "private-evaluation-questions",
    }))
  : { cases: baseline.cases, digest: null, kind: "baseline-packet-cases" };
const selected = evaluationInput.cases.find((item) => item.id === caseId);
if (!selected) throw new Error(`Unknown prepared baseline case: ${caseId}`);
const existing = await readFile(join(state, "run.json"), "utf8").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (existing)
  throw new Error(
    "Baseline case already has isolated state; preserve it and choose a new run directory",
  );
const code = await exec("git", ["rev-parse", "HEAD"], { cwd: resolve(".") });
const codeRevision = {
  head: code.stdout.trim(),
  files: Object.fromEntries(
    await Promise.all(
      [
        "pilot-baseline.mjs",
        "pilot-baseline-snapshot.mjs",
        "pilot-baseline-history.mjs",
        "pilot-model.mjs",
        "pilot-reply.mjs",
      ].map(async (file) => [
        `experiments/letta/${file}`,
        createHash("sha256")
          .update(await readFile(join("experiments", "letta", file)))
          .digest("hex"),
      ]),
    ),
  ),
};
const startedAt = new Date().toISOString();
await mkdir(state, { recursive: true, mode: 0o700 });

let model;
let historyClient;
try {
  let archive = snapshot.snapshotArchive(baseline.sources);
  let availableSources = baseline.sourceMap;
  let replay = {
    kind: "stored-corpus-operator-baseline",
    authority:
      "Stored private corpus replay: supplied read-only source packets, not freshly validated Discord originals.",
    sourceAvailability: { available: baseline.sourceMap.size, considered: baseline.sourceMap.size },
  };
  if (historyReaderInput) {
    const [{ default: pg }, history, { decodeUnderstanding }] = await Promise.all([
      import("pg"),
      import("./pilot-baseline-history.mjs"),
      import("./pilot-memory.mjs"),
    ]);
    historyClient = new pg.Client(historyConfig(await readFile(historyReaderInput)));
    await historyClient.connect();
    archive = history.historyArchive(historyClient);
    const entries = decodeUnderstanding(baseline.memory.content);
    if (!entries) throw new Error("Baseline memory is not version 2 understanding");
    const cited = new Set(entries.flatMap((entry) => entry.evidence.map((item) => item.messageId)));
    const available = await archive.availableSourceIds([...cited]);
    availableSources = new Map([...available].map((id) => [id, true]));
    replay = {
      kind: "full-memory-historical-archive-replay",
      authority:
        "Historical-archive replay: configured read-only PostgreSQL archive, not freshly validated Discord originals.",
      sourceAvailability: { available: available.size, considered: cited.size },
    };
  }
  await saveJson(join(state, "run.json"), {
    ...replay,
    publicDelivery: false,
    startedAt,
    case: selected,
    caseInput: { kind: evaluationInput.kind, digest: evaluationInput.digest },
    codeRevision,
    model: "chatgpt-plus-pro/gpt-6-sol",
    initialMemoryRevision: baseline.memory.revision,
    packetDigests: baseline.packetDigests,
    packetSourceCount: baseline.sources.length,
  });
  await record({
    type: "baseline_start",
    publicDelivery: false,
    case: selected,
    codeRevision,
    initialMemoryRevision: baseline.memory.revision,
    packetDigests: baseline.packetDigests,
    replay,
    caseInput: { kind: evaluationInput.kind, digest: evaluationInput.digest },
  });
  model = await pilotModel(archive.search, {
    botId: "444444444444444444",
    sourceLookup: archive.sourceLookup,
    validateSources: async () => {},
    discussions: archive,
    memoryFactory: () => snapshot.isolatedMemory(state, baseline.memory, availableSources),
  });
  const turnStartedAt = Date.now();
  const result = await model.turn(
    {
      rows: [],
      replyTo: null,
      context: {},
      operatorRequest: {
        id: `baseline-${selected.id}`,
        prompt: selected.prompt,
        requestedAt: startedAt,
        origin: "operator",
        delivery: "chat",
      },
    },
    0,
  );
  const latencyEvent = (await readFile(join(state, "transcripts", "pilot.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .reverse()
    .find((event) => event.type === "latency" && event.scope === "model");
  const readableMemory = await model.memory.read();
  const memory = await model.memory.full();
  await saveJson(join(state, "result.json"), {
    kind: `${replay.kind}-result`,
    publicDelivery: false,
    case: selected,
    codeRevision,
    initialMemoryRevision: baseline.memory.revision,
    finalReadableMemoryRevision: readableMemory.revision,
    finalMemoryRevision: memory.revision,
    replay,
    reply: result.reply,
    decisions: result.candidate.audit,
    evidence: result.replyEvidence,
    latency: {
      wallDurationMs: Date.now() - turnStartedAt,
      phases: latencyEvent?.stages ?? [],
    },
  });
  await record({
    type: "baseline_result",
    publicDelivery: false,
    caseId: selected.id,
    initialMemoryRevision: baseline.memory.revision,
    finalMemoryRevision: memory.revision,
  });
  console.log(
    JSON.stringify({
      caseId: selected.id,
      status: "completed",
      result: join(state, "result.json"),
    }),
  );
} catch (error) {
  await record({
    type: "baseline_failure",
    publicDelivery: false,
    caseId,
    error: safeError(error),
  });
  throw error;
} finally {
  await model?.close();
  await historyClient?.end();
}
