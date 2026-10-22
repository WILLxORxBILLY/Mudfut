import { readFile, writeFile, rename, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateMemoryFileFrontmatter } from "@letta-ai/letta-code/memory-constraints";
const exec = promisify(execFile);
const revision = (text) => createHash("sha256").update(text).digest("hex");

export function validateMemory(input, maxLength = 12000) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !["content", "expectedRevision"].includes(k)) ||
    typeof input.content !== "string" ||
    input.content.length > maxLength ||
    !/^[a-f0-9]{64}$/.test(input.expectedRevision ?? "")
  )
    throw new Error("Invalid memory update");
}

// ponytail: one 12k-character note and one runtime writer for this proof.
// Before concurrent channels, split notes by member/episode and use a durable
// per-agent update queue. The revision check detects stale updates here.
export function memoryStore(directory, { maxLength = 12000, filename = "community.md" } = {}) {
  const path = join(directory, filename);
  async function read() {
    let content = "";
    try {
      if (!(await lstat(path)).isFile()) throw new Error("Memory path must be a regular file");
      content = await readFile(path, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return { content, revision: revision(content) };
  }
  async function write(input) {
    validateMemory(input, maxLength);
    const previous = await read();
    if (previous.revision !== input.expectedRevision)
      throw new Error("Memory changed; read it again before revising");
    const errors = validateMemoryFileFrontmatter({
      path: "community.md",
      content: input.content,
      previousContent: previous.content || null,
      format: "memfs-v2",
    });
    if (errors.length) throw new Error(errors.join("\n"));
    const tmp = join(directory, `.community-${randomUUID()}.tmp`);
    await writeFile(tmp, input.content, { flag: "wx", mode: 0o600 });
    await rename(tmp, path);
    // The controller only commits bytes authored by Letta; it does not extract facts.
    await exec("git", ["-C", directory, "add", "--", filename]);
    const changed = await exec("git", [
      "-C",
      directory,
      "diff",
      "--cached",
      "--name-only",
      "--",
      filename,
    ]);
    if (changed.stdout.trim())
      await exec("git", [
        "-C",
        directory,
        "-c",
        "user.name=Mudfut",
        "-c",
        "user.email=mudfut@local.invalid",
        "commit",
        "-m",
        "Update revisable community understanding",
        "--",
        filename,
      ]);
    const commit = await exec("git", ["-C", directory, "rev-parse", "HEAD"]);
    return { ...(await read()), commit: commit.stdout.trim(), storage: "Letta MemFS" };
  }
  return { read, write };
}
