import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateArchiveManifest } from "./community-knowledge.mjs";
import { validateHistoryPass } from "./pilot-history.mjs";
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

test("invalid history identifiers do not publish stage or activation artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mudfut-manifest-boundary-"));
  const directory = join(root, "state");
  const cli = fileURLToPath(new URL("./community-knowledge-cli.mjs", import.meta.url));
  const config = { guildId, channelId };
  try {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "pilot.json"), JSON.stringify(config), { mode: 0o600 });
    const boundary = {
      ...manifest("m".repeat(64)),
      episodes: [{ ...manifest("x").episodes[0], key: "k".repeat(64) }],
    };
    assert.doesNotThrow(() =>
      validateHistoryPass({ id: boundary.id, episodes: boundary.episodes }, config),
    );
    assert.doesNotThrow(() => validateArchiveManifest(boundary));
    for (const invalid of [
      { ...boundary, id: "m".repeat(65) },
      { ...boundary, episodes: [{ ...boundary.episodes[0], key: "k".repeat(65) }] },
    ]) {
      assert.doesNotThrow(
        () => validateArchiveManifest(invalid),
        "historical manifests remain readable",
      );
      const input = join(root, "input.json");
      await writeFile(input, JSON.stringify(invalid), { mode: 0o600 });
      const result = spawnSync(process.execPath, [cli, "stage", input], {
        env: { ...process.env, MUDFUT_STATE_DIR: directory },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.deepEqual(await readdir(directory), ["pilot.json"], "stage left no artifact");
      await assert.rejects(activateCommunityManifest(directory, invalid, config));
      assert.deepEqual(await readdir(directory), ["pilot.json"], "activation left no artifact");
    }
    const input = join(root, "valid.json");
    await writeFile(input, JSON.stringify(boundary), { mode: 0o600 });
    const valid = spawnSync(process.execPath, [cli, "stage", input], {
      env: { ...process.env, MUDFUT_STATE_DIR: directory },
      encoding: "utf8",
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(await activeCommunityManifest(directory), boundary);
    const before = (await readdir(directory)).sort();
    await assert.rejects(
      activateCommunityManifest(directory, { ...boundary, id: "m".repeat(65) }, config),
    );
    assert.deepEqual((await readdir(directory)).sort(), before);
    assert.deepEqual(await activeCommunityManifest(directory), boundary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
