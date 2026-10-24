import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { scriptJson, validateSnapshot, renderInspector } from "./coverage-inspector.mjs";

// Inline validation canaries only; no fabricated operator report or source content.
const snapshot = {
  schemaVersion: "mudfut-coverage-v1",
  generatedAt: "2026-01-01T00:00:00Z",
  capturedAt: { archive: null, native: null, cloudProof: null },
  scope: { inventoryComplete: false },
  summary: {
    archived: 2,
    searchable: 2,
    reviewedExactCurrentRevision: 0,
    reviewUnknownRevision: 1,
    reviewedTemporalCurrentCandidates: 1,
    retainedProvenance: 2,
  },
  channels: [
    {
      id: "validation-channel",
      name: "</script><img src=x onerror=alert(1)>",
      scope: "archived",
      metrics: {
        archived: 2,
        searchable: 2,
        reviewedExactCurrentRevision: 0,
        reviewUnknownRevision: 1,
        reviewedTemporalCurrentCandidates: 1,
        retainedProvenance: 2,
      },
      notes: [],
      sources: [
        {
          id: "validation-source",
          reviewStatus: "unknown-revision",
          proof: "temporal-reconstruction-only",
          retainedProvenance: { currentEntries: 1, historicalVersions: 2 },
        },
      ],
      sourcesComplete: false,
      sourcesLimit: 1,
      sourcesSelection: "Validation selection",
    },
  ],
  limitations: ["Counts overlap; inventory unknown."],
  sourceCoverage: {
    included: 1,
    totalKnown: 2,
    selection: "Bounded validation metadata",
    complete: false,
  },
};
assert.equal(validateSnapshot(snapshot), snapshot);
assert.equal(snapshot.summary.reviewedExactCurrentRevision, 0);
assert.equal(
  snapshot.summary.retainedProvenance,
  2,
  "Retained provenance must not be silently reclassified as exact review",
);
assert.equal(
  snapshot.summary.reviewedTemporalCurrentCandidates,
  1,
  "Temporal-only evidence must remain its own tier",
);
for (const alter of [
  (value) => {
    value.summary.searchable = 3;
  },
  (value) => {
    value.summary.reviewedTemporalCurrentCandidates = 2;
  },
  (value) => {
    value.sourceCoverage.complete = true;
  },
  (value) => {
    value.summary.archived = -1;
  },
  (value) => {
    value.summary.pending = NaN;
  },
  (value) => {
    value.summary.retainedProvenance = "2";
  },
  (value) => {
    value.channels[0].sources[0].reviewStatus = "current";
  },
  (value) => {
    value.channels[0].sources[0].url = "javascript:alert(1)";
  },
  (value) => {
    value.scope.password = "canary";
  },
  (value) => {
    value.sourceCoverage.included = 2;
  },
  (value) => {
    value.channels.push(value.channels[0]);
  },
  (value) => {
    value.generatedAt = "2026-02-30T00:00:00Z";
  },
  (value) => {
    value.generatedAt = "yesterday";
  },
]) {
  const bad = structuredClone(snapshot);
  alter(bad);
  assert.throws(() => validateSnapshot(bad), /Invalid coverage snapshot/);
}
const canary = "</script><script>alert(1)</script>&\u2028\u2029";
assert.ok(!/[<>&\u2028\u2029]/.test(scriptJson(canary)));
assert.equal(JSON.parse(scriptJson(canary)), canary);
const html = renderInspector(snapshot);
assert.equal((html.match(/<script>/g) ?? []).length, 1);
assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
assert.ok(!html.includes(snapshot.channels[0].name));
const script = html.match(/<script>([\s\S]*)<\/script>/)[1],
  style = html.match(/<style>([\s\S]*)<\/style>/)[1];
assert.doesNotThrow(() => new Script(script), "Generated script must remain valid JavaScript");
for (const body of [script, style])
  assert.ok(
    html.includes(`'sha256-${createHash("sha256").update(body).digest("base64")}'`),
    "CSP must match the exact embedded bytes",
  );
assert.match(html, /connect-src 'none'/);
assert.match(html, /textContent/);
assert.ok(!/innerHTML|fetch\(|XMLHttpRequest|localStorage|eval\(/.test(html));
assert.match(html, /Unknown values are not zero/);
assert.match(html, /not a processing funnel/);
assert.ok(!html.includes("% reviewed"));
console.log(
  "Coverage inspector rejects invalid metadata and metric confusion, preserves unknowns, and escapes script-boundary canaries under exact CSP hashes.",
);
