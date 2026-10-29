import { readFile, lstat, link, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateArchiveManifest } from "./community-knowledge.mjs";
import { stageHistoryRequest, validateHistoryPass } from "./pilot-history.mjs";

const activeName = "community-knowledge-manifest.json";
const archiveDirectory = "community-knowledge-manifests";

async function privateManifest(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error(`${path} must be a private regular file`);
  return validateArchiveManifest(JSON.parse(await readFile(path, "utf8")));
}

const canonical = (manifest) => JSON.stringify(validateArchiveManifest(manifest));

async function publishImmutable(path, manifest) {
  const value = validateArchiveManifest(manifest);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, canonical(value) + "\n", { flag: "wx", mode: 0o600 });
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (canonical(await privateManifest(path)) !== canonical(value))
        throw new Error("A manifest ID already names a different immutable selection");
    }
  } finally {
    await unlink(temporary);
  }
}

export async function activeCommunityManifest(directory) {
  try {
    return await privateManifest(join(directory, activeName));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// A worker must be stopped by the caller: it caches the active manifest at startup.
export async function activateCommunityManifest(directory, input, config) {
  const next = validateArchiveManifest(input);
  validateHistoryPass({ id: next.id, episodes: next.episodes }, config);
  const active = await activeCommunityManifest(directory);
  const archive = join(directory, archiveDirectory);
  await mkdir(archive, { recursive: true, mode: 0o700 });
  if (active) await publishImmutable(join(archive, `${active.id}.json`), active);
  await publishImmutable(join(archive, `${next.id}.json`), next);
  await stageHistoryRequest(directory, { id: next.id, episodes: next.episodes }, config);
  if (active && canonical(active) === canonical(next))
    return { disposition: "already-active", manifest: next };
  const destination = join(directory, activeName);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, canonical(next) + "\n", { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return { disposition: active ? "activated" : "staged", manifest: next };
}
