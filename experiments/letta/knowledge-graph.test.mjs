import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { buildGraph, annotationKey, selectGraph } from "./knowledge-graph/model.mjs";
import { layoutGraph } from "./knowledge-graph/layout.mjs";
import { demoRecords, demoSnapshot } from "./knowledge-graph/synthetic.mjs";
import { readOnly, readPilot, readArchive } from "./knowledge-graph/data.mjs";
import { graphServer } from "./knowledge-graph/server.mjs";

const candidate = (graph, id = "trip-plan", revision = 2) =>
  graph.nodes.find((node) => node.id === annotationKey({ id, revision }));

test("source-bound graph preserves corrections, exact quotes, context boundaries and revision identity", () => {
  const records = demoRecords(),
    graph = buildGraph(records),
    current = candidate(graph);
  assert.equal(current.evidenceStatus, "matches stored revision");
  assert.equal(current.evidence.find((item) => item.role === "context").sourceId, "demo-102");
  assert.equal(
    current.evidence.find((item) => item.sourceId === "demo-103").original.replyTo,
    "outside-selection",
  );
  assert.equal(
    graph.nodes.find((node) => node.id === "message:demo-103").outsideParent,
    "outside-selection",
  );
  assert.ok(
    !graph.nodes.some((node) => node.id === "message:outside-selection"),
    "never invent unselected parent content",
  );
  assert.ok(graph.edges.some((edge) => edge.relation === "context only"));
  assert.ok(
    graph.edges.some((edge) => edge.relation === "qualifies" && edge.to.startsWith("claim:")),
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.from === current.id &&
        edge.to === candidate(graph, "trip-plan", 1).id &&
        edge.relation === "revises",
    ),
  );
  assert.equal(current.corrections[0].status, "accepted");
  assert.equal(candidate(graph, "afternoon-plan", 1).evidenceStatus, "stale");
  assert.equal(
    candidate(graph, "afternoon-plan", 1).evidence[0].original.content,
    "The morning train may be easier.",
  );
  assert.equal(
    candidate(graph, "afternoon-plan", 1).evidence[0].current.content,
    "The afternoon train may be easier.",
  );
  assert.ok(graph.edges.every((edge) => edge.explicit));
  assert.ok(
    !graph.edges.some((edge) => edge.from.startsWith("person:") && edge.to.startsWith("person:")),
    "co-occurrence must not create social ties",
  );
  const quoted = structuredClone(records);
  quoted.annotations[1].candidate.sourceQuotes[0].quote = "A quote that never occurred.";
  assert.equal(candidate(buildGraph(quoted)).evidenceStatus, "stale");
  const attribution = structuredClone(records);
  attribution.annotations[1].candidate.claims[0].anchors[0].attributedTo = "theo";
  assert.equal(candidate(buildGraph(attribution)).evidenceStatus, "stale");
  const missing = structuredClone(records);
  missing.sources = missing.sources.filter((source) => source.id !== "demo-101");
  assert.equal(candidate(buildGraph(missing)).evidenceStatus, "unavailable");
  const unbound = structuredClone(records);
  unbound.jobs = [];
  assert.equal(candidate(buildGraph(unbound)).evidenceStatus, "unknown");
});

test("focus is an exact one-hop neighborhood, filters and pagination preserve inspectable records", () => {
  const graph = buildGraph(demoRecords()),
    id = candidate(graph).id;
  const one = selectGraph(graph, { focus: id, depth: 1, limit: 1000 }),
    two = selectGraph(graph, { focus: id, depth: 2, limit: 1000 });
  assert.ok(
    one.nodes.every(
      (node) =>
        node.id === id ||
        graph.edges.some(
          (edge) =>
            (edge.from === id && edge.to === node.id) || (edge.to === id && edge.from === node.id),
        ),
    ),
  );
  assert.ok(two.nodes.length > one.nodes.length);
  const stale = selectGraph(graph, { type: "candidate", status: "stale" });
  assert.equal(stale.total, 2); // old corrected version and changed source
  assert.ok(
    selectGraph(graph, { query: "supply van", type: "message" }).nodes.some(
      (node) => node.id === "message:demo-103",
    ),
  );
  const page1 = selectGraph(graph, { limit: 2 }),
    page2 = selectGraph(graph, { limit: 2, offset: 2 });
  assert.equal(page1.total, page2.total);
  assert.ok(page1.nodes.every((node) => !page2.nodes.some((other) => other.id === node.id)));
});

test("adapter enforces READ ONLY transactions, bounded timeouts, rollback and redacts database errors at HTTP boundary", async () => {
  const calls = [];
  class FakeClient {
    async connect() {
      calls.push("connect");
    }
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    }
    async end() {
      calls.push("end");
    }
  }
  assert.equal(
    await readOnly(
      {},
      async (db) => {
        await db.query("SELECT 1");
        return 7;
      },
      FakeClient,
    ),
    7,
  );
  assert.ok(calls.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
  assert.ok(calls.includes("SET LOCAL statement_timeout='10s'"));
  assert.ok(calls.includes("COMMIT"));
  assert.equal(calls.at(-1), "end");
  calls.length = 0;
  await assert.rejects(
    readOnly(
      {},
      () => {
        throw new Error("private-password-canary");
      },
      FakeClient,
    ),
  );
  assert.ok(calls.includes("ROLLBACK"));
  assert.equal(calls.at(-1), "end");
  const server = graphServer(async () => {
    throw new Error("private-password-canary");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address().port,
      response = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("private-password-canary"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("coverage uses committed history receipts, counts direct candidate sources separately and retains archive unknowns", async () => {
  const queries = [],
    records = demoRecords();
  const db = {
    query: async (sql) => {
      queries.push(sql);
      const rows = sql.includes("FROM pilot_knowledge_annotations")
        ? records.annotations.map((row) => ({
            ...row,
            source_ids: [...row.source_ids, ...(row.candidate.contextSourceIds ?? [])],
          }))
        : sql.includes("FROM pilot_knowledge_sources")
          ? records.sources
          : sql.includes("FROM pilot_knowledge_source_revisions")
            ? records.revisions
            : sql.includes("FROM pilot_knowledge_receipts")
              ? records.jobs
              : sql.includes("FROM pilot_knowledge_corrections")
                ? records.corrections
                : sql.includes("FROM pilot_knowledge_manifests")
                  ? records.manifests
                  : sql.includes("unnest(e.read_ids)")
                    ? [{ id: "demo-101" }, { id: "demo-103" }]
                    : sql.includes("unnest(e.context_ids)")
                      ? [{ id: "demo-102" }]
                      : sql.includes("jsonb_array_elements_text")
                        ? [{ id: "demo-deferred" }]
                        : sql.includes("GROUP BY status")
                          ? [
                              { status: "done", count: 1 },
                              { status: "deferred", count: 1 },
                            ]
                          : sql.includes("FROM pilot_sources")
                            ? [{ stored: 4, nondeleted: 4 }]
                            : sql.includes("FROM pilot_memory_entries")
                              ? [{ entries: 2 }]
                              : [];
      return { rows };
    },
  };
  const pilot = await readPilot(db);
  assert.equal(pilot.stages.reviewed.length, 2);
  assert.deepEqual(pilot.stages.represented.sort(), [
    "demo-101",
    "demo-103",
    "demo-104",
    "demo-201",
    "demo-202",
    "demo-203",
    "demo-301",
    "demo-303",
    "demo-401",
    "demo-402",
    "demo-403",
    "demo-501",
    "demo-502",
  ]);
  assert.ok(!pilot.stages.represented.includes("demo-102"));
  assert.ok(!pilot.stages.represented.includes("demo-302"));
  for (const sql of queries.filter((sql) => sql.includes("unnest(e."))) {
    assert.match(sql, /e.status='done'/);
    assert.match(sql, /w.status='done'/);
    assert.match(sql, /w.history_episode=e.id/);
    assert.ok(!sql.includes("learned"));
  }
  const archive = await readArchive(
    {
      query: async (sql, params) => {
        assert.match(sql, /thread_id IS NULL/);
        assert.match(sql, /message_id=ANY\(\$1::text\[\]\)/);
        assert.deepEqual(params[0], pilot.stages.reviewed);
        return { rows: demoSnapshot().coverage.archive.rows };
      },
    },
    pilot.stages,
  );
  assert.equal(archive.total.stored, 231);
  assert.equal(archive.inventory, "unknown");
  assert.match(archive.note, /Stages overlap/);
});

test("loopback server serves a usable demo, rejects cross-origin/host writes and never exposes private files", async () => {
  const server = graphServer(async () => demoSnapshot());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port,
    base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Knowledge atlas/);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const response = await fetch(base + "/api/snapshot");
    assert.equal((await response.json()).mode, "FICTIONAL DEMO · not Discord history");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(base + "/layout.mjs")).status, 200);
    assert.equal(
      (await fetch(base + "/api/snapshot", { headers: { Origin: "https://untrusted.example" } }))
        .status,
      403,
    );
    assert.equal((await fetch(base + "/api/snapshot", { method: "POST" })).status, 403);
    assert.equal((await fetch(base + "/postgres.json")).status, 404);
    const hostStatus = await new Promise((resolve, reject) => {
      const req = request(
        base + "/api/snapshot",
        { headers: { host: "untrusted.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(hostStatus, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("guided demo destinations preserve corrections, edited sources, competing perspectives and reconciled fictional coverage", () => {
  const snapshot = demoSnapshot(),
    { graph, demo, coverage } = snapshot;
  assert.equal(demo.stories.length, 4);
  for (const story of demo.stories) {
    if (story.view === "coverage") continue;
    assert.ok(graph.nodes.some((node) => node.id === story.nodeId));
    const view = selectGraph(graph, { focus: story.nodeId, depth: story.depth });
    assert.ok(view.nodes.length > 1);
  }
  assert.equal(graph.nodes.filter((node) => node.type === "person").length, 6);
  assert.equal(coverage.archive.rows.length, 5);
  for (const key of [
    "stored",
    "usable",
    "reviewed",
    "context",
    "represented",
    "selected",
    "deferred",
    "without_review_receipt",
  ])
    assert.equal(
      coverage.archive.total[key],
      coverage.archive.rows.reduce((sum, row) => sum + row[key], 0),
    );
  assert.equal(coverage.archive.inventory, "unknown");
  const records = demoRecords();
  for (const row of records.annotations) {
    const manifest = records.manifests.find((m) => m.id === row.manifest_id);
    const episode = manifest.manifest.episodes.find(
      (e) => `${manifest.id}:${e.key}` === row.episode_id,
    );
    assert.ok(episode, `Missing selection for ${row.id}`);
    assert.ok(row.candidate.sourceIds.every((id) => episode.sourceIds.includes(id)));
  }

  assert.equal(
    coverage.stages.represented,
    new Set(
      demoRecords()
        .annotations.filter((row) => row.status === "candidate")
        .flatMap((row) => row.candidate.sourceIds),
    ).size,
  );
  const disagreement = selectGraph(graph, { focus: demo.stories[2].nodeId, depth: 2 });
  assert.ok(disagreement.nodes.some((node) => node.id === "candidate:garden-beds@1"));
  assert.ok(disagreement.edges.some((edge) => edge.relation.startsWith("competes with")));
});

test("map layout is deterministic and stays finite and bounded for empty, isolated and dense views", () => {
  assert.equal(layoutGraph([], []).size, 0);
  const graph = demoSnapshot().graph;
  for (const nodes of [
    graph.nodes.slice(0, 1),
    graph.nodes,
    Array.from({ length: 100 }, (_, i) => ({ id: `isolated:${i}`, type: "message" })),
  ]) {
    const a = layoutGraph(nodes, graph.edges),
      b = layoutGraph([...nodes].reverse(), graph.edges);
    assert.deepEqual([...a], [...b]);
    assert.equal(a.size, nodes.length);
    for (const point of a.values()) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.ok(point.x >= point.w / 2 && point.x <= 1000 - point.w / 2);
      assert.ok(point.y >= point.h / 2 && point.y <= 560 - point.h / 2);
    }
  }
});

test("guided neighborhoods keep label boxes apart on desktop and compact screens", () => {
  const snapshot = demoSnapshot();
  for (const story of snapshot.demo.stories.filter((item) => item.nodeId)) {
    const view = selectGraph(snapshot.graph, { focus: story.nodeId, depth: story.depth });
    for (const [width, height] of [
      [1000, 560],
      [360, 660],
    ]) {
      const points = [...layoutGraph(view.nodes, view.edges, width, height).values()];
      for (let a = 0; a < points.length; a++)
        for (let b = a + 1; b < points.length; b++) {
          const p = points[a],
            q = points[b];
          assert.ok(
            Math.abs(p.x - q.x) >= (p.w + q.w) / 2 || Math.abs(p.y - q.y) >= (p.h + q.h) / 2,
            `Label overlap in ${story.id} at ${width}px`,
          );
        }
    }
  }
});
