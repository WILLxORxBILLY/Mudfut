import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT_CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPOSITORY = "WILLxORxBILLY/Mudfut";

// No shell, fetch, package install, runtime imports, or environment-file loading.
function execute(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_OPTIONAL_LOCKS: "0",
      COREPACK_ENABLE_NETWORK: "0",
      // Honor the already-installed project pin; selecting Corepack's global
      // default can require an uncached version even when this pin is cached.
      COREPACK_ENABLE_PROJECT_SPEC: "1",
      COREPACK_ENABLE_AUTO_PIN: "0",
      COREPACK_DEFAULT_TO_LATEST: "0",
      npm_config_manage_package_manager_versions: "false",
      npm_config_offline: "true",
    },
  });
  if (result.error || result.status !== 0) throw new Error("command failed");
  return result.stdout;
}

function canonicalRepository(origin) {
  // Reject URL credentials, ports, query strings and other hosts; never report
  // the original URL (including in errors). SSH's conventional git user is safe.
  return /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)WILLxORxBILLY\/Mudfut(?:\.git)?\/?$/i.test(
    origin,
  )
    ? REPOSITORY
    : null;
}

export function sourceIdentity({
  checkout = SCRIPT_CHECKOUT,
  run = execute,
  nodeVersion = process.version,
} = {}) {
  const report = {
    schemaVersion: 1,
    status: "rejected",
    scope: "local-source-identity-only",
    qualification: {
      ci: "unverified",
      installedRuntime: "unverified",
      deployment: "unverified",
    },
    source: {
      repository: null,
      commit: null,
      tree: null,
      dirty: { tracked: null, untracked: null },
      lockfileSha256: null,
    },
    versions: {
      node: { required: null, observed: null },
      pnpm: { required: null, observed: null },
    },
    errors: [],
  };
  const fail = (code) => report.errors.push(code);
  let root;
  try {
    root = realpathSync(checkout);
  } catch {
    fail("checkout-unavailable");
    return report;
  }
  const git = (...args) =>
    run("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], root);
  try {
    if (realpathSync(git("rev-parse", "--show-toplevel").trim()) !== root) {
      fail("checkout-must-be-repository-root");
      return report;
    }
    const commit = git("rev-parse", "--verify", "HEAD^{commit}").trim();
    const tree = git("rev-parse", "--verify", "HEAD^{tree}").trim();
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree) ||
      commit.length !== tree.length
    ) {
      throw new Error("invalid identity");
    }
    report.source.commit = commit;
    report.source.tree = tree;
  } catch {
    fail("git-identity-unavailable-or-malformed");
    return report;
  }
  try {
    const origin = git("config", "--local", "--get", "remote.origin.url").trim();
    report.source.repository = canonicalRepository(origin);
    if (!report.source.repository) fail("repository-origin-not-allowed");
  } catch {
    fail("repository-origin-unavailable");
  }
  try {
    const status = git(
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    );
    let tracked = false;
    let untracked = false;
    const entries = status.split("\0");
    if (entries.pop() !== "") throw new Error("invalid status");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!/^(?:\?\?|[ MADRCUT?!]{2}) .+$/s.test(entry)) {
        throw new Error("invalid status");
      }
      if (entry.startsWith("?? ")) untracked = true;
      else tracked = true;
      if (/^[RC]|^.[RC]/.test(entry) && !entries[++i]) {
        throw new Error("invalid rename");
      }
    }
    report.source.dirty = { tracked, untracked };
    if (tracked || untracked) fail("dirty-source");
  } catch {
    fail("git-status-unavailable-or-malformed");
  }
  try {
    // Status can hide changed files marked assume-unchanged or skip-worktree.
    // Reject concealed/sparse index entries instead of changing their flags.
    const entries = git("ls-files", "-v", "-z").split("\0");
    if (entries.pop() !== "" || entries.length === 0) throw new Error("invalid index flags");
    let concealed = false;
    for (const entry of entries) {
      if (!/^[A-Za-z?] .+$/s.test(entry)) throw new Error("invalid index flags");
      if (!entry.startsWith("H ")) concealed = true;
    }
    if (concealed) fail("git-index-flags-not-allowed");
  } catch {
    fail("git-index-flags-unavailable-or-malformed");
  }
  try {
    git("ls-files", "--error-unmatch", "--", "package.json", "pnpm-lock.yaml");
    for (const file of ["package.json", "pnpm-lock.yaml"]) {
      if (!lstatSync(resolve(root, file)).isFile()) {
        throw new Error("metadata must be regular files");
      }
    }
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const node = manifest.engines?.node;
    const pnpm = manifest.packageManager;
    // ponytail: support only major.x Node and exact pnpm pins; add tested semver
    // handling before widening manifest syntax, never guess on unknown ranges.
    if (
      typeof node !== "string" ||
      !/^\d+\.x$/.test(node) ||
      typeof pnpm !== "string" ||
      !/^pnpm@\d+\.\d+\.\d+$/.test(pnpm)
    ) {
      throw new Error("invalid requirements");
    }
    report.versions.node.required = node;
    report.versions.pnpm.required = pnpm.slice(5);
    report.source.lockfileSha256 = createHash("sha256")
      .update(readFileSync(resolve(root, "pnpm-lock.yaml")))
      .digest("hex");
  } catch {
    fail("source-metadata-unavailable-or-malformed");
  }
  if (typeof nodeVersion === "string" && /^v\d+\.\d+\.\d+$/.test(nodeVersion)) {
    report.versions.node.observed = nodeVersion.slice(1);
    if (
      report.versions.node.required &&
      nodeVersion.slice(1).split(".")[0] !== report.versions.node.required.split(".")[0]
    ) {
      fail("node-version-mismatch");
    }
  } else fail("node-version-unavailable-or-malformed");
  try {
    const pnpm = run("pnpm", ["--version"], root).trim();
    if (!/^\d+\.\d+\.\d+$/.test(pnpm)) throw new Error("invalid version");
    report.versions.pnpm.observed = pnpm;
    if (report.versions.pnpm.required && pnpm !== report.versions.pnpm.required) {
      fail("pnpm-version-mismatch");
    }
  } catch {
    fail("pnpm-version-unavailable-or-malformed");
  }
  if (report.errors.length === 0) report.status = "source-identified";
  return report;
}

export function main(args = process.argv.slice(2)) {
  // An explicit path is resolved against the caller; the default is always this
  // script's checkout, never an inferred live installation or arbitrary cwd.
  const report =
    args.length > 1 || (args[0] && args[0].startsWith("-"))
      ? { status: "rejected", errors: ["usage: release:preflight [checkout-root]"] }
      : sourceIdentity({ checkout: args[0] ? resolve(args[0]) : SCRIPT_CHECKOUT });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.status === "source-identified" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
