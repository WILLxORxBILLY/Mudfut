import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isolatedMemory, loadBaseline, snapshotArchive } from "./pilot-baseline-snapshot.mjs";

const source = (id, content, createdAt, replyTo = null) => ({
  id,
  guildId: "111111111111111111",
  channelId: "222222222222222222",
  authorId: "333333333333333333",
  authorName: "Member",
  content,
  createdAt,
  editedAt: null,
  replyTo,
  url: `https://discord.com/channels/111111111111111111/222222222222222222/${id}`,
});

test("stored-corpus manifest binds every consumed file before replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mudfut-baseline-manifest-"));
  const names = [
    "cases.json",
    "memory-before-selection.json",
    "bo-food-plan.sources.json",
    "domestic-work.earlier-context.json",
    "domestic-work.sources.json",
    "fisher-rangers.sources.json",
    "sports-idleness.sources.json",
    "suburban-families.sources.json",
  ];
  const content = "fictional memory";
  const hashes = {};
  try {
    for (const name of names) {
      const data =
        name === "cases.json"
          ? JSON.stringify({ cases: [{ id: "fictional", prompt: "What happened?" }] })
          : name === "memory-before-selection.json"
            ? JSON.stringify({
                row: { content, revision: createHash("sha256").update(content).digest("hex") },
              })
            : "[]";
      await writeFile(join(directory, name), data);
      hashes[name] = createHash("sha256").update(data).digest("hex");
    }
    await writeFile(join(directory, "MANIFEST.json"), JSON.stringify({ files: {} }));
    await assert.rejects(loadBaseline(directory), /manifest.*missing/i);
    for (const name of names) {
      const incomplete = { ...hashes };
      delete incomplete[name];
      await writeFile(join(directory, "MANIFEST.json"), JSON.stringify({ files: incomplete }));
      await assert.rejects(loadBaseline(directory), /manifest.*missing/i);
    }
    await writeFile(join(directory, "MANIFEST.json"), JSON.stringify({ files: hashes }));
    const loaded = await loadBaseline(directory);
    assert.deepEqual(loaded.cases, [{ id: "fictional", prompt: "What happened?" }]);
    assert.equal(loaded.memory.content, content);
    await writeFile(join(directory, names[2]), "[{}]");
    await assert.rejects(loadBaseline(directory), /checksum mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored-corpus archive searches, pages, and expands only prepared sources", async () => {
  const first = "555555555555555501";
  const second = "555555555555555502";
  const third = "555555555555555503";
  const archive = snapshotArchive([
    source(first, "Cooking is a fun hobby", "2026-05-24T19:00:00.000Z"),
    source(second, "Cooking is not a moral obligation", "2026-05-24T19:01:00.000Z", first),
    source(third, "Unrelated sports talk", "2026-05-24T19:02:00.000Z"),
  ]);
  const search = await archive.search({ query: "cooking OR obligation" });
  assert.deepEqual(
    search.sources.map((item) => item.id),
    [first, second],
  );
  assert.match(search.authority, /Stored private corpus replay/);
  const page = await archive.browseArchive({ channelIds: ["222222222222222222"], limit: 2 });
  assert.equal(page.sources.length, 2);
  assert.ok(page.cursor);
  const next = await archive.browseArchive({ cursor: page.cursor });
  assert.deepEqual(
    next.sources.map((item) => item.id),
    [third],
  );
  const discussion = await archive.readDiscussion({ anchorId: second });
  assert.deepEqual(
    new Set(discussion.sources.map((item) => item.id)),
    new Set([first, second, third]),
  );
  assert.deepEqual(discussion.roles[first], ["chronological-neighbor", "reply-ancestor"]);
});

test("stored-corpus memory keeps a private before-and-after revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mudfut-baseline-memory-"));
  try {
    const hidden = {
      key: "unavailable",
      evidence: [{ messageId: "555555555555555501", quote: "outside packet" }],
    };
    const before = `---\nname: community\n---\n${JSON.stringify({ version: 2, entries: [hidden] })}`;
    const available = "555555555555555502";
    const current = {
      key: "current",
      evidence: [{ messageId: available, quote: "in packet" }],
    };
    const memory = await isolatedMemory(
      directory,
      { content: before, revision: createHash("sha256").update(before).digest("hex") },
      new Set([available]),
    );
    const next = `---\nname: community\n---\n${JSON.stringify({ version: 2, entries: [current] })}`;
    await memory.write({ content: next, expectedRevision: (await memory.read()).revision });
    assert.equal(JSON.parse(await readFile(join(directory, "memory-before.json"))).content, before);
    const after = JSON.parse(await readFile(join(directory, "memory-after.json"))).content;
    assert.match(after, /unavailable/);
    assert.match(after, /current/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
