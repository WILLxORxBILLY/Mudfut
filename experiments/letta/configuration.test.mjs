import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configuredModel, personaStyle } from "./configuration.mjs";

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
