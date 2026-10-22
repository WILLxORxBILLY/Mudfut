import { readFile, lstat, link, mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { state, assertPrivateState } from "./runtime.mjs";
import { communityKnowledgeStatus, validateArchiveManifest } from "./community-knowledge.mjs";
import { stageHistoryRequest } from "./pilot-history.mjs";
import { validateScope } from "./pilot-store.mjs";
import { activateCommunityManifest } from "./community-knowledge-manifest.mjs";

const [command, input] = process.argv.slice(2);
if (
  ![
    ["stage", Boolean(input)],
    ["activate", Boolean(input)],
    ["status", !input],
    ["report", !input],
  ].some(([name, valid]) => name === command && valid)
)
  throw new Error(
    "Use stage|activate /private/path/to/community-archive-manifest.json, status or report",
  );
assertPrivateState(state);

async function privateJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error(`${path} must be a private regular file`);
  return JSON.parse(await readFile(path, "utf8"));
}

const destination = join(state, "community-knowledge-manifest.json");
if (command === "status") {
  try {
    const manifest = validateArchiveManifest(await privateJson(destination));
    console.log(
      JSON.stringify({
        id: manifest.id,
        generation: manifest.generation,
        episodes: manifest.episodes.length,
      }),
    );
  } catch (error) {
    if (error.code === "ENOENT") console.log(JSON.stringify({ status: "not-staged" }));
    else throw error;
  }
} else if (command === "report") {
  const db = new pg.Client(await privateJson(join(state, "postgres.json")));
  try {
    await db.connect();
    console.log(JSON.stringify(await communityKnowledgeStatus(db)));
  } finally {
    await db.end().catch(() => {});
  }
} else {
  const source = resolve(input);
  assertPrivateState(source);
  const manifest = validateArchiveManifest(await privateJson(source));
  const config = validateScope(await privateJson(join(state, "pilot.json")));
  if (command === "activate") {
    const db = new pg.Client(await privateJson(join(state, "postgres.json")));
    let ownsWorkerLock = false;
    try {
      await db.connect();
      ownsWorkerLock = (await db.query("SELECT pg_try_advisory_lock(1560387,1127029) AS acquired"))
        .rows[0].acquired;
      if (!ownsWorkerLock)
        throw new Error("Stop the pilot worker before activating a different community manifest");
      const outcome = await activateCommunityManifest(state, manifest, config);
      console.log(
        JSON.stringify({
          status: outcome.disposition,
          id: manifest.id,
          episodes: manifest.episodes.length,
        }),
      );
    } finally {
      if (ownsWorkerLock)
        await db.query("SELECT pg_advisory_unlock(1560387,1127029)").catch(() => {});
      await db.end().catch(() => {});
    }
  } else {
    await mkdir(state, { recursive: true, mode: 0o700 });
    const temporary = join(state, `.community-knowledge-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o600 });
    try {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const saved = validateArchiveManifest(await privateJson(destination));
        if (JSON.stringify(saved) !== JSON.stringify(manifest))
          throw new Error("A different immutable community archive manifest is already staged");
      }
    } finally {
      await unlink(temporary);
    }
    await stageHistoryRequest(state, { id: manifest.id, episodes: manifest.episodes }, config);
    console.log(
      JSON.stringify({ status: "staged", id: manifest.id, episodes: manifest.episodes.length }),
    );
  }
}
