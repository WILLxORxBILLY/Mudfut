// Capture explicit source evidence locally without staging or changing pilot state.
import pg from "pg";
import { readFile, writeFile, link, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { state, assertPrivateState } from "./runtime.mjs";
import {
  assertResearchArchiveAuthority,
  exportResearchEpisode,
  validateResearchManifest,
} from "./pilot-research-export.mjs";

process.umask(0o077);
const [manifestPath, outputPath] = process.argv.slice(2).map((path) => resolve(path));
if (!manifestPath || !outputPath || process.argv.length !== 4)
  throw new Error("Use /private/manifest.json /private/research-episode.json");
assertPrivateState(manifestPath);
assertPrivateState(outputPath);
const manifest = validateResearchManifest(JSON.parse(await readFile(manifestPath, "utf8")));
const credentials = JSON.parse(await readFile(join(state, "history-postgres.json"), "utf8"));
assertResearchArchiveAuthority(credentials);
const client = new pg.Client({
  ...credentials,
  statement_timeout: 20_000,
  connectionTimeoutMillis: 10_000,
  options: "-c default_transaction_read_only=on",
});
await client.connect();
let receipt;
try {
  receipt = await exportResearchEpisode(client, manifest);
} finally {
  await client.end();
}
const payload = JSON.stringify(receipt, null, 2) + "\n";
const temporary = join(dirname(outputPath), `.${randomUUID()}.research-export.tmp`);
try {
  await writeFile(temporary, payload, { flag: "wx", mode: 0o600 });
  await link(temporary, outputPath);
} finally {
  await rm(temporary, { force: true });
}
console.log(
  JSON.stringify({ id: manifest.id, sources: receipt.sources.length, sha256: receipt.sha256 }),
);
