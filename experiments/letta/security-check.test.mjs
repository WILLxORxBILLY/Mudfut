import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const letta = createRequire(require.resolve("@letta-ai/letta-code"));

test("patched image dependencies still decode and resize; both dependency paths resolve safely", async () => {
  for (const name of ["sharp", "@janhapke/sharp-electron"]) {
    // Exercise the actual entry point: its old Linux branch loaded vendored
    // 0.35.3 even when the nested fallback dependency was already patched.
    const sharp = letta(name);
    assert.equal(sharp.versions.sharp, "0.35.5");
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const resized = await sharp(png).resize(2, 2).png().toBuffer();
    assert.equal((await sharp(resized).metadata()).width, 2);
  }
});

test("all bundled MCP OAuth entry points reject before touching credentials or network", async () => {
  const directory = dirname(require.resolve("@letta-ai/letta-code"));
  for (const file of ["letta.js", "dist/mcp-client.js", "dist/mcp-oauth.js"]) {
    const code = await readFile(join(directory, file), "utf8");
    for (const name of ["auth", "fetchToken"]) {
      const prefix = code.match(
        new RegExp(
          `async function ${name}\\([^\\n]+\\) \\{\\n(?:  //[^\\n]*\\n)*  throw new Error\\("MCP OAuth is disabled[^\\n]+;`,
        ),
      );
      assert.ok(prefix, `${file}: ${name} must remain guarded in the installed package`);
      const guarded = runInNewContext(`(${prefix[0]}\n})`);
      const poison = new Proxy(
        {},
        {
          get() {
            throw new Error("Credentials were accessed");
          },
        },
      );
      await assert.rejects(guarded(poison, "https://untrusted.invalid"), /MCP OAuth is disabled/);
    }
  }
});

test("Vitest runs both native worker pools without the removed Tinypool dependency", async () => {
  const vitest = createRequire(require.resolve("vitest"));
  assert.throws(() => vitest.resolve("tinypool"), { code: "MODULE_NOT_FOUND" });
  const packageDirectory = dirname(require.resolve("vitest/package.json"));
  const directory = await mkdtemp(join(tmpdir(), "mudfut-pool-"));
  const config = join(directory, "vitest.config.mjs");
  await writeFile(config, 'export default { test: { include: ["worker.test.mjs"] } };\n');
  await writeFile(
    join(directory, "worker.test.mjs"),
    `import { test, expect } from ${JSON.stringify(pathToFileURL(join(packageDirectory, "dist/index.js")).href)};\n` +
      'test("worker executes", () => expect(21 * 2).toBe(42));\n',
  );
  try {
    for (const pool of ["threads", "forks"]) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          join(packageDirectory, "vitest.mjs"),
          "run",
          "--root",
          directory,
          "--config",
          config,
          "--pool",
          pool,
        ],
        { timeout: 30000 },
      );
      assert.match(stdout, /1 passed/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
