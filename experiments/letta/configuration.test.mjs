import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  configuredModel,
  modelProvider,
  personaStyle,
  resumePreflight,
  serviceProgramArguments,
  DEFAULT_MODEL,
} from "./configuration.mjs";

test("supervisor refuses repository state before process metadata or failure logging", async () => {
  const directory = fileURLToPath(new URL(`../../.invalid-state-${randomUUID()}`, import.meta.url));
  await assert.rejects(lstat(directory), { code: "ENOENT" });
  try {
    const supervisor = fileURLToPath(new URL("pilot-supervisor.mjs", import.meta.url));
    for (const model of ["chatgpt-plus-pro/example-model", "other/model", "openai/gpt-5"]) {
      const result = spawnSync(process.execPath, [supervisor], {
        env: { ...process.env, MUDFUT_MODEL: model, MUDFUT_STATE_DIR: directory },
        encoding: "utf8",
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.match(result.stderr, /Runtime state must be outside the repository/);
      await assert.rejects(lstat(directory), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed model handle stops supervised startup before any client is built", async () => {
  const directory = await mkdtemp(join(tmpdir(), "community-invalid-model-"));
  try {
    const env = { ...process.env, MUDFUT_MODEL: "not-a-handle", MUDFUT_STATE_DIR: directory };
    const supervisor = fileURLToPath(new URL("pilot-supervisor.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [supervisor], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(output, "");
    assert.deepEqual(await readdir(directory), ["transcripts"]);
    const failure = JSON.parse(
      await readFile(join(directory, "transcripts", "pilot.jsonl"), "utf8"),
    );
    assert.equal(failure.type, "supervisor_blocked");
    assert.match(failure.error, /MUDFUT_MODEL/);
    const runtime = new URL("runtime.mjs", import.meta.url).href;
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict"; import { makeClient, runtimeModel } from ${JSON.stringify(runtime)}; assert.throws(runtimeModel, /MUDFUT_MODEL/); await assert.rejects(makeClient(), /MUDFUT_MODEL/);`,
      ],
      { env: { ...env, MUDFUT_STATE_DIR: join(directory, "client") }, stdio: "pipe" },
    );
    assert.deepEqual(await readdir(directory), ["transcripts"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a well-formed model for a provider with no credentials is refused at startup, not mid-turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "community-missing-provider-"));
  try {
    const runtime = new URL("runtime.mjs", import.meta.url).href;
    for (const model of [
      "lc-anthropic/claude-test-model",
      "openai/gpt-test-model",
      "groq/llama-test",
    ]) {
      const env = {
        ...process.env,
        MUDFUT_MODEL: model,
        MUDFUT_STATE_DIR: join(directory, model.replace(/\W+/g, "-")),
        MUDFUT_AUTH_MODE: "letta",
      };
      for (const name of [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_OAUTH_TOKEN",
        "GEMINI_API_KEY",
        "OLLAMA_API_KEY",
      ])
        delete env[name];
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { makeClient } from ${JSON.stringify(runtime)}; await makeClient().then(() => { throw new Error("unexpected success"); }, (e) => { console.log(e.message); });`,
        ],
        { env, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /cannot start/i);
      assert.match(result.stdout, /No credentials for provider/);
      assert.match(result.stdout, /letta connect/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an API-key provider starts without writing secrets into the state directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "community-apikey-"));
  try {
    const state = join(directory, "state");
    const runtime = new URL("runtime.mjs", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { prepareRuntime, runtimeModel, unavailableProviderReason } from ${JSON.stringify(runtime)};
         console.log(runtimeModel());
         console.log(await unavailableProviderReason(runtimeModel()));
         await prepareRuntime();
         console.log("prepared");`,
      ],
      {
        env: {
          ...process.env,
          MUDFUT_MODEL: "lc-anthropic/claude-test-model",
          MUDFUT_AUTH_MODE: "letta",
          MUDFUT_STATE_DIR: state,
          ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key",
          OPENAI_API_KEY: "",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").at(-1), "prepared");
    // prepareRuntime must not persist an Anthropic key into the provider store.
    await assert.rejects(readFile(join(state, "letta", "providers", "auth.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("service startup loads repository model/style settings and retains its installed state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "community service-"));
  try {
    const runtimeRoot = join(directory, "experiments", "letta");
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(
      join(runtimeRoot, "pilot-supervisor.mjs"),
      `console.log(JSON.stringify({model: process.env.MUDFUT_MODEL ?? null, style: process.env.MUDFUT_PERSONA_STYLE_FILE ?? null, state: process.env.MUDFUT_STATE_DIR, auth: process.env.MUDFUT_AUTH_MODE}));`,
    );
    const style = join(directory, "operator style.md");
    await writeFile(
      join(directory, ".env"),
      `MUDFUT_MODEL=chatgpt-plus-pro/example-model\nMUDFUT_PERSONA_STYLE_FILE="${style}"\nMUDFUT_STATE_DIR=other-state\nMUDFUT_AUTH_MODE=letta\n`,
    );
    const [executable, ...args] = serviceProgramArguments(process.execPath, runtimeRoot);
    const launch = () =>
      JSON.parse(
        execFileSync(executable, args, {
          cwd: tmpdir(),
          env: { MUDFUT_STATE_DIR: "installed-state", MUDFUT_AUTH_MODE: "letta" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    assert.deepEqual(launch(), {
      model: "chatgpt-plus-pro/example-model",
      style,
      state: "installed-state",
      auth: "letta",
    });
    await rm(join(directory, ".env"));
    assert.deepEqual(launch(), {
      model: null,
      style: null,
      state: "installed-state",
      auth: "letta",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("model handles are provider-agnostic but still bounded", () => {
  assert.equal(configuredModel(), DEFAULT_MODEL);
  assert.equal(modelProvider(DEFAULT_MODEL), "chatgpt-plus-pro");
  for (const value of [
    "chatgpt-plus-pro/example-model",
    "openai/gpt-5.1",
    "lc-anthropic/claude-sonnet-4-5",
    "openai-compatible/qwen2.5-72b-instruct",
    "ollama/llama3.2:3b",
    "amazon-bedrock/anthropic.claude-3-5-sonnet",
    "lc-openrouter/anthropic/claude-3.5-sonnet",
    "groq/llama-3.3-70b-versatile",
  ])
    assert.equal(configuredModel(value), value, value);
  assert.equal(configuredModel("  openai/gpt-5.1  "), "openai/gpt-5.1");
  for (const value of [
    "",
    null,
    "no-slash",
    "/leading",
    "provider/",
    "other/model\nextra",
    "chatgpt-plus-pro/../secret",
    "provider/model with space",
    "provider//double",
    "-bad-provider/x",
  ])
    assert.throws(() => configuredModel(value), /MUDFUT_MODEL/, String(value));
});

test("resume refuses to clear a held receipt when no supervisor is installed", () => {
  // Clearing the hold is the only way past a quota latch, so it may not happen
  // unless a plist exists for launchctl bootstrap to load.
  assert.throws(() => resumePreflight(false), /run install before resume/);
  assert.deepEqual(resumePreflight(true), { failures: [], held: false, running: false });
});

test("optional persona style is local, bounded, nonempty and cannot follow a symlink", async () => {
  assert.equal(await personaStyle(undefined), "");
  await assert.rejects(personaStyle("relative.md"), /absolute path/);
  const directory = await mkdtemp(join(tmpdir(), "community-style-"));
  try {
    const path = join(directory, "style.md");
    await writeFile(path, "Use the name Cedar and a calm, concise voice.");
    assert.match(await personaStyle(path), /preserve the source, tool and evidence rules/);
    assert.match(await personaStyle(path), /Cedar/);
    const link = join(directory, "link.md");
    await symlink(path, link);
    await assert.rejects(personaStyle(link), /regular file/);
    await assert.rejects(personaStyle(directory), /regular file/);
    await writeFile(path, "   ");
    await assert.rejects(personaStyle(path), /contain/);
    await writeFile(path, "é".repeat(4001));
    await assert.rejects(personaStyle(path), /8,000 bytes/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential lookup finds a provider however the operator spelled its handle", async () => {
  const runtime = new URL("runtime.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { providerCandidates } from ${JSON.stringify(runtime)};
       const out = {};
       for (const provider of ["anthropic", "lc-anthropic", "openai-codex", "chatgpt-plus-pro", "gemini", "bedrock", "kimi-code", "unknown-provider"])
         out[provider] = providerCandidates(provider);
       console.log(JSON.stringify(out));`,
    ],
    { env: { ...process.env }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const groups = JSON.parse(result.stdout);
  for (const name of ["anthropic", "lc-anthropic"])
    assert.ok(groups[name].includes("lc-anthropic"), name);
  for (const name of ["openai-codex", "chatgpt-plus-pro"])
    assert.ok(groups[name].includes("chatgpt-plus-pro"), name);
  assert.ok(groups.gemini.includes("google"), "gemini");
  assert.ok(groups.bedrock.includes("amazon-bedrock"), "bedrock");
  assert.ok(groups["kimi-code"].includes("kimi-coding"), "kimi-code");
  // An unknown provider is its own candidate rather than a silent wildcard.
  assert.deepEqual(groups["unknown-provider"], ["unknown-provider"]);
});

test("local endpoints need no credential, hosted providers do", async () => {
  const runtime = new URL("runtime.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { requiresCredential, unavailableProviderReason } from ${JSON.stringify(runtime)};
       const out = {};
       for (const handle of ["ollama/llama3.2", "lmstudio/local-model", "llama.cpp/local", "anthropic/claude-test", "openai/gpt-test"])
         out[handle] = { needs: requiresCredential(handle.split("/")[0]), reason: await unavailableProviderReason(handle) };
       console.log(JSON.stringify(out));`,
    ],
    {
      env: {
        ...process.env,
        MUDFUT_STATE_DIR: join(tmpdir(), "community-no-store-" + randomUUID()),
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  for (const handle of ["ollama/llama3.2", "lmstudio/local-model", "llama.cpp/local"]) {
    assert.equal(out[handle].needs, false, handle);
    assert.equal(out[handle].reason, null, handle);
  }
  for (const handle of ["anthropic/claude-test", "openai/gpt-test"]) {
    assert.equal(out[handle].needs, true, handle);
    assert.match(out[handle].reason, /No credentials/, handle);
  }
});
