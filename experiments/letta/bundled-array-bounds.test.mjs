// Run: node experiments/letta/bundled-array-bounds.test.mjs (offline; never executes Letta entrypoints).
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import * as z from "zod";
import * as core from "zod/v4/core";

const require = createRequire(import.meta.url);
function packageRoot(resolver, name) {
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const file = join(directory, name, "package.json");
    if (existsSync(file)) return dirname(realpathSync(file));
  }
  throw new Error("Missing installed package: " + name);
}
const code = packageRoot(require, "@letta-ai/letta-code");
const sdk = packageRoot(require, "@letta-ai/letta-agent-sdk");
const nestedSdk = packageRoot(
  createRequire(join(code, "package.json")),
  "@letta-ai/letta-agent-sdk",
);
assert.equal(JSON.parse(readFileSync(join(code, "package.json"))).version, "0.34.14");
assert.equal(JSON.parse(readFileSync(join(sdk, "package.json"))).version, "0.8.44");
assert.equal(JSON.parse(readFileSync(join(nestedSdk, "package.json"))).version, "0.8.38");

function arrayConstructor(source) {
  const start = source.indexOf("$ZodArray = /*");
  const end = source.indexOf("$ZodObject = /*", start);
  assert(start >= 0 && end > start, "Review constructor extraction after a package rebuild");
  const region = source.slice(start, end);
  const close = /\n[ ]{0,2}\}\);/u.exec(region);
  assert(close, "Missing complete array constructor");
  const body = region.slice(0, close.index + close[0].length);
  // ponytail: exercises emitted constructor code against protocol-compatible pure core;
  // full SDK lifecycle fixtures remain required when upgrading these pinned bundles.
  return Function(
    "$constructor",
    "$ZodType",
    "handleArrayResult",
    `let $ZodArray; ${body}; return $ZodArray;`,
  )(core.$constructor, core.$ZodType, (result, payload, index) => {
    if (result.issues.length) payload.issues.push(...core.util.prefixIssues(index, result.issues));
    payload.value[index] = result.value;
  });
}

const files = [
  ...["letta.js", "dist/mcp-client.js", "dist/mcp-oauth.js"].map((file) => join(code, file)),
  join(sdk, "dist/index.js"),
  join(nestedSdk, "dist/index.js"),
];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  if (file.startsWith(code))
    assert.equal(
      source.split("MCP OAuth is disabled in this pilot build (CVE-2026-104850)").length - 1,
      2,
      "Both existing OAuth guards must remain in each Letta-code artifact",
    );
  const ArraySchema = arrayConstructor(source);
  for (const exact of [false, true]) {
    for (const async of [false, true]) {
      let visits = 0;
      const child = {
        _zod: {
          run(payload) {
            visits++;
            return async ? Promise.resolve(payload) : payload;
          },
        },
      };
      const check = exact
        ? new core.$ZodCheckLengthEquals({ check: "length_equals", length: 2 })
        : new core.$ZodCheckMaxLength({ check: "max_length", maximum: 2 });
      const schema = new ArraySchema({ type: "array", element: child, checks: [check] });
      let reads = 0;
      const oversized = Array.from({ length: 8 }, (_, index) => index);
      Object.defineProperty(oversized, 0, { get: () => ++reads });
      const result = await schema._zod.run({ value: oversized, issues: [] }, { async });
      assert.equal(visits, 0, "Oversized bundle input visited child parsers: " + file);
      assert.equal(reads, 0, "Oversized bundle input read child values: " + file);
      assert(result.issues.some((issue) => issue.code === "too_big"));
      const valid = await schema._zod.run({ value: [1, 2], issues: [] }, { async });
      assert.equal(visits, 2);
      assert.equal(valid.issues.length, 0);
      if (exact) {
        const small = await schema._zod.run({ value: [1], issues: [] }, { async });
        assert(small.issues.some((issue) => issue.code === "too_small"));
      }
    }
  }
}

for (const kind of ["array", "set", "map"]) {
  for (const async of [false, true]) {
    let visits = 0;
    const child = z.any().transform((value) => {
      visits++;
      return async ? Promise.resolve(value) : value;
    });
    const schema =
      kind === "array"
        ? z.array(child).max(2)
        : kind === "set"
          ? z.set(child).max(2)
          : z.map(child, child).check(core._maxSize(2));
    const input =
      kind === "array"
        ? [1, 2, 3]
        : kind === "set"
          ? new Set([1, 2, 3])
          : new Map([
              [1, 1],
              [2, 2],
              [3, 3],
            ]);
    const result = async ? await schema.safeParseAsync(input) : schema.safeParse(input);
    assert.equal(result.success, false);
    assert.equal(visits, 0, "Oversized installed Zod input visited children: " + kind);
  }
}
console.log(
  "PASS: five actual emitted bundles and installed array/set/map bounds; OAuth guards retained",
);
