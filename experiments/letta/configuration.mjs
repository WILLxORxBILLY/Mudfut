import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export function configuredModel(value = "chatgpt-plus-pro/gpt-6-sol") {
  if (
    typeof value !== "string" ||
    !/^chatgpt-plus-pro\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
  )
    throw new Error("MUDFUT_MODEL must name a model in the chatgpt-plus-pro provider");
  return value;
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
