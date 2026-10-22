import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { configuredModel } from "./configuration.mjs";

export const root = dirname(fileURLToPath(import.meta.url));
export const state = resolve(
  process.env.MUDFUT_STATE_DIR ?? join(homedir(), ".local", "state", "mudfut-letta"),
);
export const transcriptDir = join(state, "transcripts");
export const authFile = resolve(
  process.env.MUDFUT_CODEX_AUTH_FILE ??
    join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
);
export const backend = join(state, "letta");
export const model = configuredModel(process.env.MUDFUT_MODEL);

export function assertPrivateState(directory) {
  let ancestor = resolve(directory);
  const missing = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const physical = resolve(realpathSync(ancestor), ...missing);
  const rel = relative(realpathSync(resolve(root, "../..")), physical);
  if (
    !isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/"))
  )
    throw new Error("Runtime state must be outside the repository");
}

export async function saveJson(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}

export async function prepareRuntime() {
  assertPrivateState(state);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  await mkdir(join(state, "work"), { recursive: true, mode: 0o700 });
  process.env.LETTA_LOCAL_BACKEND_DIR = backend;
  process.env.LETTA_BACKEND = "local";
  // No paid API fallback or inherited unrelated provider credential.
  delete process.env.OPENAI_API_KEY;
  delete process.env.LETTA_API_KEY;
  if (process.env.MUDFUT_AUTH_MODE === "letta") {
    const provider = JSON.parse(await readFile(join(backend, "providers", "auth.json"), "utf8"))
      .providers?.["chatgpt-plus-pro"];
    if (provider?.auth?.type !== "oauth" || !provider.auth.refresh)
      throw new Error("Pilot requires its own renewable Letta subscription login");
    // Letta's native provider store serializes refresh-token rotation and persists
    // the replacement. Never overwrite it with the prototype's Codex snapshot.
    return;
  }
  if (process.env.MUDFUT_AUTH_MODE && process.env.MUDFUT_AUTH_MODE !== "codex-snapshot")
    throw new Error("Unknown subscription authentication mode");
  let source;
  try {
    source = JSON.parse(await readFile(authFile, "utf8"));
  } catch {
    throw new Error(
      "Cannot read the configured Codex auth file; a local ChatGPT file-based login is required",
    );
  }
  if (source.auth_mode !== "chatgpt" || !source.tokens?.access_token) {
    throw new Error("A ChatGPT subscription login is required. Run codex login.");
  }
  const token = source.tokens.access_token;
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  const expires = payload.exp * 1000;
  if (!Number.isFinite(expires) || expires < Date.now() + 10 * 60_000) {
    throw new Error("Refresh the Codex subscription login before running this demo.");
  }
  // ponytail: snapshot the still-valid access token for this local experiment;
  // no refresh token is copied or rotated. Unattended operation needs its own
  // Letta OAuth login; restarting refreshes this snapshot from Codex.
  await saveJson(join(backend, "providers", "auth.json"), {
    version: 1,
    providers: {
      "chatgpt-plus-pro": {
        id: "local-provider-chatgpt-plus-pro",
        name: "chatgpt-plus-pro",
        provider_type: "chatgpt_oauth",
        provider_category: "byok",
        auth: { type: "oauth", access: token, expires, accountId: source.tokens.account_id },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
  });
}

export async function makeClient() {
  await prepareRuntime();
  const { LettaAgentClient } = await import("@letta-ai/letta-agent-sdk");
  return new LettaAgentClient({
    backend: "local",
    appServer: {
      pinGlobalAgent: false,
      requestTimeoutMs: 180_000,
      startupTimeoutMs: 60_000,
    },
  });
}

export function safeError(error) {
  return String(error?.message ?? error)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted token]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted key]");
}
