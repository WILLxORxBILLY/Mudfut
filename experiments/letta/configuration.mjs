import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export function serviceProgramArguments(executable, runtimeRoot) {
  return [
    executable,
    `--env-file-if-exists=${resolve(runtimeRoot, "../..", ".env")}`,
    resolve(runtimeRoot, "pilot-supervisor.mjs"),
  ];
}

// Deliberate resume is the only path that may clear a latched failure, so it must
// prove a supervisor can actually be started first. Clearing the receipt and then
// failing to bootstrap would drop the hold without running anything.
export function resumePreflight(plistExists) {
  if (!plistExists)
    throw new Error(
      "Service is not installed; run install before resume so the held receipt is not cleared without a supervisor to start",
    );
  return { failures: [], held: false, running: false };
}

// Mudfut is model-agnostic: any provider name the local Letta runtime can
// authenticate works here. The runtime decides which credentials exist; this
// module only rejects shapes that cannot be a provider handle at all, so a bad
// value fails before a worker spawns rather than in the middle of a turn.
//
// A handle is "<provider>/<model>". The provider segment is matched loosely
// because local provider names are the runtime's to define ("chatgpt-plus-pro",
// "lc-anthropic", "openai", "openai-compatible", "ollama", ...). The model
// segment must not be empty, must not contain whitespace or a path separator,
// and cannot begin with a dot, so it cannot escape or inject.
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export const DEFAULT_MODEL = "chatgpt-plus-pro/gpt-6-sol";

export function configuredModel(value = DEFAULT_MODEL) {
  if (typeof value !== "string" || !HANDLE.test(value.trim()))
    throw new Error(
      'MUDFUT_MODEL must be a "<provider>/<model>" handle naming a model the configured provider can serve',
    );
  if (
    value
      .trim()
      .split("/")
      .slice(1)
      .join("/")
      .split("/")
      .some((segment) => segment === "..")
  )
    throw new Error("MUDFUT_MODEL must not contain a parent path segment");
  return value.trim();
}

export function modelProvider(model) {
  return configuredModel(model).split("/")[0];
}

export async function personaStyle(path) {
  if (path === undefined) return "";
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("MUDFUT_PERSONA_STYLE_FILE must be an absolute path");
  const info = await lstat(path);
  if (!info.isFile() || info.size > 8000)
    throw new Error("Persona style must be a regular file of at most 8,000 bytes");
  const content = await readFile(path, "utf8");
  if (!content.trim() || Buffer.byteLength(content, "utf8") > 8000)
    throw new Error("Persona style must contain 1–8,000 bytes of text");
  return `Operator-provided style preferences; preserve the source, tool and evidence rules above:\n${content}`;
}
