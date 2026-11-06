import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { configuredModel, modelProvider } from "./configuration.mjs";

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
export const providerStore = join(backend, "providers", "auth.json");
export const runtimeModel = () => configuredModel(process.env.MUDFUT_MODEL);

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
  return physical;
}

export async function saveJson(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}

// Read the local provider store without assuming any particular provider exists.
export async function readProviderStore() {
  try {
    const parsed = JSON.parse(await readFile(providerStore, "utf8"));
    return parsed?.providers && typeof parsed.providers === "object" ? parsed.providers : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

// A provider is usable when the local store holds a credential for it, OR when
// the operator supplied its key in the environment. The second form is what makes
// API-key operation possible without writing secrets into the state directory.
const ENV_KEYS = {
  openai: ["OPENAI_API_KEY"],
  "lc-openai": ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"],
  "lc-anthropic": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"],
  google: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  "lc-gemini": ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "lc-openrouter": ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
  "lc-xai": ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "lc-moonshot": ["MOONSHOT_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "lc-zai": ["ZAI_API_KEY"],
  "lc-zai-coding": ["ZAI_CODING_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "lc-minimax": ["MINIMAX_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  huggingface: ["HF_TOKEN"],
  nvidia: ["NVIDIA_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  "openai-compatible": ["OPENAI_COMPATIBLE_API_KEY"],
  "lc-openai-compatible": ["OPENAI_COMPATIBLE_API_KEY"],
  ollama: ["OLLAMA_API_KEY"],
  "lc-ollama": ["OLLAMA_API_KEY"],
  "ollama-cloud": ["OLLAMA_API_KEY"],
  "lc-ollama-cloud": ["OLLAMA_API_KEY"],
  lmstudio: ["LMSTUDIO_API_KEY"],
  "lc-lmstudio": ["LMSTUDIO_API_KEY"],
  "llama.cpp": ["LLAMA_CPP_API_KEY"],
  "lc-llama-cpp": ["LLAMA_CPP_API_KEY"],
  "amazon-bedrock": ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"],
  "lc-bedrock": ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"],
  "amazon-bedrock-anthropic": ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
};

export const providerEnvKeys = (provider) => ENV_KEYS[provider] ?? [];

export function providerFromEnvironment(provider) {
  const set = providerEnvKeys(provider).filter((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim() !== "";
  });
  return set.length ? set : undefined;
}

// A model handle's provider segment and the name the provider store uses are not
// always identical: `letta connect anthropic` may store "lc-anthropic", and the
// ChatGPT subscription is stored as "chatgpt-plus-pro" while its handle prefix is
// "openai-codex/". Each group lists every spelling the runtime may use for one
// provider, so a credential is found however the operator wrote the handle.
const PROVIDER_GROUPS = [
  ["chatgpt-plus-pro", "openai-codex", "codex", "chatgpt-oauth"],
  ["openai", "lc-openai", "openai-responses"],
  ["anthropic", "lc-anthropic"],
  ["openai-compatible", "lc-openai-compatible"],
  ["openrouter", "lc-openrouter"],
  ["ollama", "lc-ollama"],
  ["ollama-cloud", "lc-ollama-cloud"],
  ["lmstudio", "lc-lmstudio"],
  ["llama.cpp", "llama-cpp", "lc-llama-cpp"],
  ["google", "google-ai", "google_ai", "gemini", "lc-gemini"],
  ["google-vertex", "google_vertex"],
  ["amazon-bedrock", "bedrock", "lc-bedrock"],
  ["zai", "lc-zai"],
  ["zai-coding", "zai_coding", "lc-zai-coding"],
  ["minimax", "lc-minimax"],
  ["moonshotai", "moonshot", "lc-moonshot"],
  ["kimi-coding", "kimi-code", "moonshot_coding", "lc-kimi-code"],
  ["xai", "lc-xai"],
  ["groq"],
  ["deepseek"],
  ["mistral"],
  ["cerebras"],
  ["fireworks"],
  ["baseten"],
  ["huggingface"],
  ["nvidia"],
  ["github-copilot"],
];

export function providerCandidates(provider) {
  const group = PROVIDER_GROUPS.find((names) => names.includes(provider));
  return group ? [...group] : [provider];
}

// Local endpoints authenticate by being reachable, not by holding a key. A
// preflight that demanded an API key would wrongly refuse to start against a
// machine the operator is running themselves.
const NO_CREDENTIAL_PROVIDERS = new Set([
  "ollama",
  "lc-ollama",
  "lmstudio",
  "lc-lmstudio",
  "llama.cpp",
  "llama-cpp",
  "lc-llama-cpp",
]);

export function requiresCredential(provider) {
  return !providerCandidates(provider).some((name) => NO_CREDENTIAL_PROVIDERS.has(name));
}

// Explain precisely why a model cannot run, so an operator sees the fix rather
// than a mid-turn failure. Returns null when the model is runnable.
export async function unavailableProviderReason(model) {
  const provider = modelProvider(model);
  const candidates = providerCandidates(provider);
  if (!requiresCredential(provider)) return null;
  if (candidates.some((name) => providerFromEnvironment(name))) return null;
  const store = await readProviderStore();
  const record = candidates.map((name) => store[name]).find(Boolean);
  if (!record) {
    const local = Object.keys(store);
    const envHint = candidates.flatMap((name) => providerEnvKeys(name))[0];
    return [
      `No credentials for provider "${provider}".`,
      local.length
        ? `The local provider store has: ${local.join(", ")}.`
        : "The local provider store is empty.",
      `Run: letta connect <provider> with LETTA_LOCAL_BACKEND_DIR="${backend}"`,
      envHint ? `or set ${envHint} in the environment.` : "or authenticate this provider.",
    ].join(" ");
  }
  const auth = record.auth ?? {};
  if (auth.type === "oauth") {
    if (!auth.refresh && record.provider_type !== "chatgpt_oauth")
      return `Provider "${provider}" holds an OAuth credential that looks incomplete. Re-run letta connect.`;
    return null;
  }
  if (auth.type === "api") return null;
  return `Provider "${provider}" exists but has an unrecognized auth type (${String(auth.type)}). Re-run letta connect.`;
}

// Keep one deliberate property from the original design: the bot never silently
// inherits an unrelated cloud credential that the operator did not choose for it.
// The runtime now decides which provider to use from MUDFUT_MODEL, and only the
// configured provider's credential reaches it.
const NEVER_INHERIT = ["LETTA_API_KEY"];

export async function prepareRuntime() {
  assertPrivateState(state);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  await mkdir(join(state, "work"), { recursive: true, mode: 0o700 });
  process.env.LETTA_LOCAL_BACKEND_DIR = backend;
  process.env.LETTA_BACKEND = "local";
  for (const name of NEVER_INHERIT) delete process.env[name];

  const model = runtimeModel();
  const mode = process.env.MUDFUT_AUTH_MODE ?? "letta";
  if (mode !== "letta" && mode !== "codex-snapshot")
    throw new Error('MUDFUT_AUTH_MODE must be "letta" (local provider store or environment)');

  if (mode === "letta") {
    if (process.env.MUDFUT_REQUIRE_CREDENTIALS === "0") return;
    const reason = await unavailableProviderReason(model);
    if (reason) throw new Error(`Model "${model}" cannot start. ${reason}`);
    // Letta's native provider store serializes credential rotation and persists
    // the replacement, so an existing login is left untouched.
    return;
  }

  // codex-snapshot: import one short-lived ChatGPT access token into the store.
  // Only meaningful for the ChatGPT provider; it exists for the fictional model
  // proof and is not the unattended operating mode.
  if (modelProvider(model) !== "chatgpt-plus-pro")
    throw new Error('MUDFUT_AUTH_MODE=codex-snapshot only supports a "chatgpt-plus-pro/..." model');
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
  // Letta login; restarting refreshes this snapshot from Codex.
  await saveJson(providerStore, {
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
  runtimeModel();
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

export function providerQuotaExhausted(error) {
  const seen = new Set();
  for (let failure = error; failure && !seen.has(failure); failure = failure.cause) {
    seen.add(failure);
    if (
      /\b(usage_limit_reached|usage_not_included|insufficient_quota)\b|\busage limit (?:has been )?reached\b/i.test(
        `${failure.code ?? ""} ${safeError(failure)}`,
      )
    )
      return true;
  }
  return false;
}
