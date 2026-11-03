// Offline regression for the pinned Letta bundle; does not execute its entrypoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
function packageRoot() {
  for (const dir of require.resolve.paths("@letta-ai/letta-code") ?? []) {
    const file = join(dir, "@letta-ai/letta-code/package.json");
    if (existsSync(file)) return dirname(realpathSync(file));
  }
  throw new Error("Missing installed @letta-ai/letta-code");
}

test("bundled minimatch bounds expansion and quadratic preprocessing", () => {
  const root = packageRoot();
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"))).version, "0.34.14");
  const source = readFileSync(join(root, "letta.js"), "utf8");
  const marker = "  firstPhasePreProcess(globParts) {";
  const start = source.indexOf(marker);
  const end = source.indexOf("  partsMatch(a2, b3, emptyGSMatch", start);
  assert(start >= 0 && end > start, "Review minimatch extraction after a bundle rebuild");
  assert.equal(source.indexOf(marker, start + marker.length), -1);
  // ponytail: exercise the pinned bundle's two pure methods; full SDK lifecycle
  // fixtures remain required when upgrading or rebuilding the Letta package.
  const Probe = runInNewContext(
    `(class {
    constructor() { this.options = { braceExpandMax: 4 }; this.preserveMultipleSlashes = false; this.comparisons = 0; }
    partsMatch() { this.comparisons++; if (this.comparisons > 3) throw Error("unexpected large-set comparison"); return null; }
    ${source.slice(start, end)}
  })`,
    {},
    { timeout: 1000 },
  );
  const probe = new Probe();
  const pattern = Array(4).fill("**/../a/b").join("/").split("/");
  assert.equal(probe.firstPhasePreProcess([pattern]).length, 4);
  const large = Array.from({ length: 1001 }, () => ["x"]);
  assert.equal(probe.secondPhasePreProcess(large), large);
  assert.equal(probe.comparisons, 0);
  probe.secondPhasePreProcess([["a"], ["b"], ["c"]]);
  assert.equal(probe.comparisons, 3);
});
