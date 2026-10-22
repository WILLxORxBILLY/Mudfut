import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeCommunityManifest,
  activateCommunityManifest,
} from "./community-knowledge-manifest.mjs";

const guildId = "111111111111111111";
const channelId = "222222222222222222";
const sourceId = "555555555555555501";
const manifest = (id, generation = 1) => ({
  id,
  schemaVersion: "community-archive-manifest-v1",
  archiveConnectionId: "local-history-reader",
  generation,
  episodes: [
    {
      key: "bounded-source",
      label: "Synthetic bounded source",
      guildId,
      channelId,
      sourceIds: [sourceId],
      contextIds: [],
    },
  ],
});

test("community manifest activation archives the previous immutable manifest before replacing the active selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mudfut-community-manifest-"));
  const initial = manifest("first-pass");
  const next = manifest("second-pass", 2);
  try {
    await writeFile(join(directory, "community-knowledge-manifest.json"), JSON.stringify(initial), {
      mode: 0o600,
    });
    const outcome = await activateCommunityManifest(directory, next, { guildId, channelId });
    assert.equal(outcome.disposition, "activated");
    assert.deepEqual(await activeCommunityManifest(directory), next);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(directory, "community-knowledge-manifests", "first-pass.json"), "utf8"),
      ),
      initial,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "history-requests", "second-pass.json"), "utf8")),
      { id: next.id, episodes: next.episodes },
    );
    assert.equal(
      (await lstat(join(directory, "community-knowledge-manifests", "second-pass.json"))).mode &
        0o077,
      0,
    );
    assert.equal(
      (await activateCommunityManifest(directory, next, { guildId, channelId })).disposition,
      "already-active",
    );
    await assert.rejects(
      activateCommunityManifest(
        directory,
        { ...next, episodes: [{ ...next.episodes[0], label: "conflict" }] },
        { guildId, channelId },
      ),
      /different immutable selection/,
    );
    assert.deepEqual(await activeCommunityManifest(directory), next);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
