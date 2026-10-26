import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { configuredModel, personaStyle, serviceProgramArguments } from "./configuration.mjs";

test("supervisor refuses repository state before process metadata or failure logging", async () => {
  const directory = fileURLToPath(new URL(`../../.invalid-state-${randomUUID()}`, import.meta.url));
  await assert.rejects(lstat(directory), { code: "ENOENT" });
  try {
    const supervisor = fileURLToPath(new URL("pilot-supervisor.mjs", import.meta.url));
    for (const model of ["chatgpt-plus-pro/example-model", "other/model"]) {
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

test("invalid model configuration stops supervised startup and rejects clients before state setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "community-invalid-model-"));
  try {
    const env = { ...process.env, MUDFUT_MODEL: "other/model", MUDFUT_STATE_DIR: directory };
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
      `MUDFUT_MODEL=chatgpt-plus-pro/example-model\nMUDFUT_PERSONA_STYLE_FILE="${style}"\nMUDFUT_STATE_DIR=other-state\nMUDFUT_AUTH_MODE=codex-snapshot\n`,
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

test("deployment model selection stays inside the configured subscription provider", () => {
  assert.equal(configuredModel(), "chatgpt-plus-pro/gpt-6-sol");
  assert.equal(configuredModel("chatgpt-plus-pro/example-model"), "chatgpt-plus-pro/example-model");
  for (const value of [
    "",
    null,
    "other/model",
    "chatgpt-plus-pro/model\nextra",
    "chatgpt-plus-pro/../secret",
  ])
    assert.throws(() => configuredModel(value), /MUDFUT_MODEL/);
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
