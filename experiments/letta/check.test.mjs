import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validateSearch, openArchive, seed, searchArchive } from "./archive.mjs";
import { memoryStore } from "./memory.mjs";
import { root, assertPrivateState } from "./runtime.mjs";

test("strict tool inputs and durable, revision-checked Letta memory", async () => {
  assert.throws(() => assertPrivateState(join(root, "state")), /outside the repository/);
  assertPrivateState(tmpdir());
  for (const input of [
    { query: "Mira", channel: "staff" },
    { messageId: "demo-101", query: "Mira" },
    { messageId: "demo-101' OR TRUE" },
    { query: 4 },
    { messageId: 101 },
    { query: null, messageId: "demo-101" },
  ])
    assert.throws(() => validateSearch(input));
  const dir = await mkdtemp(join(tmpdir(), "mudfut-memory-check-"));
  const other = await mkdtemp(join(tmpdir(), "mudfut-memory-link-"));
  try {
    execFileSync("git", ["init", "--quiet", dir]);
    const memory = memoryStore(dir),
      first = await memory.read();
    await assert.rejects(
      memory.write({ content: "No metadata", expectedRevision: first.revision }),
      /frontmatter/,
    );
    assert.deepEqual(await memory.read(), first);
    const content =
      "---\nname: community\ndescription: Test note\n---\nA revisable note, not a source message.";
    await memory.write({ content, expectedRevision: first.revision });
    assert.equal((await memoryStore(dir).read()).content, content);
    await assert.rejects(
      memory.write({ content: "stale overwrite", expectedRevision: first.revision }),
      /changed/,
    );
    await symlink(join(dir, "community.md"), join(other, "community.md"));
    await assert.rejects(memoryStore(other).read(), /regular file/);
    await symlink(root, join(other, "checkout-link"));
    assert.throws(
      () => assertPrivateState(join(other, "checkout-link", "private-state")),
      /outside the repository/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test(
  "PostgreSQL fixtures: exact lookup, keywords, isolation, deleted sources",
  { skip: process.env.CHECK_DATABASE !== "1" },
  async () => {
    const pool = await openArchive();
    try {
      await seed(pool);
      assert.equal((await searchArchive(pool, { messageId: "demo-999" })).sources.length, 0);
      assert.equal(
        (await searchArchive(pool, { messageId: "demo-101" })).sources[0].author_id,
        "mira",
      );
      assert.ok(
        (await searchArchive(pool, { query: "compass" })).sources.some(
          (s) => s.message_id === "demo-104",
        ),
      );
      await pool.query("UPDATE messages SET deleted_at=now() WHERE message_id='demo-101'");
      await seed(pool); // replay must not resurrect the deleted source
      assert.equal((await searchArchive(pool, { messageId: "demo-101" })).sources.length, 0);
      assert.equal((await searchArchive(pool, { query: "observatory" })).sources.length, 0);
    } finally {
      await pool.end();
    }
  },
);
