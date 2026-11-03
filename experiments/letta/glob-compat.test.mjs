import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Letta's scoped glob supports its source patterns and hidden-file behavior", async () => {
  const require = createRequire(
    realpathSync(resolve("node_modules/@letta-ai/letta-code/package.json")),
  );
  assert.equal(require("glob/package.json").version, "14.0.3");
  const { glob } = require("glob");
  const root = await mkdtemp(join(tmpdir(), "mudfut-glob-"));
  try {
    await mkdir(join(root, "src/layer/.hidden"), { recursive: true });
    for (const file of ["main.ts", "view.tsx", "main.test.ts", "types.d.ts", ".hidden/secret.ts"])
      await writeFile(join(root, "src/layer", file), "");
    const opts = { cwd: root, ignore: ["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"] };
    assert.deepEqual((await glob("src/**/*.ts", opts)).sort(), ["src/layer/main.ts"]);
    assert.deepEqual((await glob("src/layer/**/*.{ts,tsx}", opts)).sort(), [
      "src/layer/main.ts",
      "src/layer/view.tsx",
    ]);
    assert.deepEqual((await glob("src/**/*.ts", { ...opts, dot: true })).sort(), [
      "src/layer/.hidden/secret.ts",
      "src/layer/main.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
