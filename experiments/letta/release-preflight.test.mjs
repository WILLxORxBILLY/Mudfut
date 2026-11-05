import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SCRIPT_CHECKOUT, sourceIdentity } from "./release-preflight.mjs";

const manifest = {
  engines: { node: "22.x" },
  packageManager: "pnpm@11.28.7",
};
const lockfile = "lockfileVersion: 9.0\n";
const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fictional Release Test",
  GIT_AUTHOR_EMAIL: "fictional@example.invalid",
  GIT_COMMITTER_NAME: "Fictional Release Test",
  GIT_COMMITTER_EMAIL: "fictional@example.invalid",
};

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fixture(t, { commit = true, files = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mudfut-source-identity-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--quiet");
  git(
    root,
    "config",
    "--local",
    "remote.origin.url",
    "https://github.com/WILLxORxBILLY/Mudfut.git",
  );
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "pnpm-lock.yaml"), lockfile);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  if (commit) {
    git(root, "add", "--", "package.json", "pnpm-lock.yaml", ...Object.keys(files));
    // All writes and commits are confined to this disposable fictional repo.
    git(
      root,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Fictional source fixture",
    );
  }
  return root;
}

const allowedGit = new Set([
  "rev-parse --show-toplevel",
  "rev-parse --verify HEAD^{commit}",
  "rev-parse --verify HEAD^{tree}",
  "config --local --get remote.origin.url",
  "status --porcelain=v1 -z --untracked-files=normal --ignore-submodules=none",
  "ls-files -v -z",
  "ls-files --error-unmatch -- package.json pnpm-lock.yaml",
]);

function inspect(root, overrides = {}) {
  const calls = [];
  const report = sourceIdentity({
    checkout: root,
    nodeVersion: overrides.nodeVersion ?? "v22.23.4",
    run(command, args, cwd) {
      assert.equal(cwd, root);
      const key = command === "git" ? args.slice(4).join(" ") : args.join(" ");
      calls.push([command, key]);
      if (command === "pnpm") {
        assert.deepEqual(args, ["--version"]);
        if (overrides.pnpmError) throw new Error("fictional secret must not escape");
        return overrides.pnpm ?? "11.28.7\n";
      }
      assert.equal(command, "git", "production/network command tripwire");
      assert.deepEqual(args.slice(0, 4), [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
      ]);
      assert.ok(allowedGit.has(key), `unexpected command: ${key}`);
      if (overrides.gitError === key) throw new Error("fictional secret must not escape");
      if (Object.hasOwn(overrides.git ?? {}, key)) return overrides.git[key];
      return git(root, ...args);
    },
  });
  return { report, calls };
}

function rejected(report, error) {
  assert.equal(report.status, "rejected");
  assert.ok(report.errors.includes(error), JSON.stringify(report));
  assert.ok(!JSON.stringify(report).includes("fictional secret"));
}

test("clean fictional source reports complete local identity, not CI or deployment readiness", (t) => {
  const root = fixture(t);
  const { report, calls } = inspect(root);
  assert.equal(report.status, "source-identified");
  assert.equal(report.source.repository, "WILLxORxBILLY/Mudfut");
  assert.equal(report.source.commit, git(root, "rev-parse", "HEAD").trim());
  assert.equal(report.source.tree, git(root, "rev-parse", "HEAD^{tree}").trim());
  assert.equal(report.source.lockfileSha256, createHash("sha256").update(lockfile).digest("hex"));
  assert.deepEqual(report.source.dirty, { tracked: false, untracked: false });
  assert.deepEqual(report.versions, {
    node: { required: "22.x", observed: "22.23.4" },
    pnpm: { required: "11.28.7", observed: "11.28.7" },
  });
  assert.deepEqual(report.qualification, {
    ci: "unverified",
    installedRuntime: "unverified",
    deployment: "unverified",
  });
  assert.equal(calls.length, 8);
  assert.equal(git(root, "status", "--porcelain"), "", "inspection did not modify source");
});

test("tracked modifications, staged changes and untracked files reject source", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "pnpm-lock.yaml"), `${lockfile}# fictional change\n`);
  rejected(inspect(root).report, "dirty-source");
  git(root, "add", "--", "pnpm-lock.yaml");
  assert.equal(inspect(root).report.source.dirty.tracked, true);
  writeFileSync(join(root, "fictional-untracked.txt"), "fictional");
  const { report } = inspect(root);
  rejected(report, "dirty-source");
  assert.deepEqual(report.source.dirty, { tracked: true, untracked: true });
  assert.ok(!JSON.stringify(report).includes("fictional-untracked"));
});

test("untracked-only source is dirty", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "fictional.txt"), "fictional");
  const { report } = inspect(root);
  rejected(report, "dirty-source");
  assert.deepEqual(report.source.dirty, { tracked: false, untracked: true });
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`source identity rejects ${flag} hiding a tracked modification`, (t) => {
    const root = fixture(t);
    git(root, "update-index", flag, "--", "pnpm-lock.yaml");
    writeFileSync(join(root, "pnpm-lock.yaml"), `${lockfile}# fictional hidden change\n`);
    assert.equal(git(root, "status", "--porcelain"), "", "Git hides the modified fixture");
    rejected(inspect(root).report, "git-index-flags-not-allowed");
  });

  test(`source identity rejects ${flag} even before a file changes`, (t) => {
    const root = fixture(t);
    git(root, "update-index", flag, "--", "pnpm-lock.yaml");
    rejected(inspect(root).report, "git-index-flags-not-allowed");
    assert.ok(
      git(root, "ls-files", "-v").includes(flag === "--skip-worktree" ? "S " : "h "),
      "inspection must not clear the fixture's index flags",
    );
  });

  test(`source identity checks ${flag} on runtime files, including unusual filenames`, (t) => {
    const name = "fictional runtime\nmodule.mjs";
    const root = fixture(t, { files: { [name]: "export const fictional = 1;\n" } });
    assert.equal(inspect(root).report.status, "source-identified");
    git(root, "update-index", flag, "--", name);
    writeFileSync(join(root, name), "export const fictional = 2;\n");
    assert.equal(git(root, "status", "--porcelain"), "");
    const { report } = inspect(root);
    rejected(report, "git-index-flags-not-allowed");
    assert.ok(!JSON.stringify(report).includes("fictional runtime"));
  });
}

test("unavailable or malformed index flags fail closed without leaking paths or errors", (t) => {
  const root = fixture(t);
  rejected(
    inspect(root, { gitError: "ls-files -v -z" }).report,
    "git-index-flags-unavailable-or-malformed",
  );
  for (const value of ["", "H fictional-secret-path", "\0", "H \0", "broken\0"]) {
    const { report } = inspect(root, { git: { "ls-files -v -z": value } });
    rejected(report, "git-index-flags-unavailable-or-malformed");
    assert.ok(!JSON.stringify(report).includes("fictional-secret-path"));
  }
  const { report } = inspect(root, { git: { "ls-files -v -z": "X fictional-secret-path\0" } });
  rejected(report, "git-index-flags-not-allowed");
  assert.ok(!JSON.stringify(report).includes("fictional-secret-path"));
});

test("untracked directories reject source without enumerating every contained file", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "fictional-directory"));
  writeFileSync(join(root, "fictional-directory", "file.txt"), "fictional");
  const { report } = inspect(root);
  rejected(report, "dirty-source");
  assert.deepEqual(report.source.dirty, { tracked: false, untracked: true });
});

test("safe GitHub origins canonicalize; wrong or credential-bearing origins never leak", (t) => {
  const root = fixture(t);
  for (const origin of [
    "git@github.com:WILLxORxBILLY/Mudfut.git",
    "ssh://git@github.com/WILLxORxBILLY/Mudfut",
    "https://github.com/willxorxbilly/mudfut",
  ]) {
    assert.equal(
      inspect(root, { git: { "config --local --get remote.origin.url": origin } }).report.status,
      "source-identified",
    );
  }
  for (const origin of [
    "https://github.com/other/repo.git",
    "https://github.com.evil.invalid/WILLxORxBILLY/Mudfut",
    "https://fictional-secret@github.com/WILLxORxBILLY/Mudfut.git",
    "https://github.com/WILLxORxBILLY/Mudfut.git?fictional-secret",
  ]) {
    const { report } = inspect(root, { git: { "config --local --get remote.origin.url": origin } });
    rejected(report, "repository-origin-not-allowed");
    assert.ok(!JSON.stringify(report).includes(origin));
    assert.ok(!JSON.stringify(report).includes("fictional-secret"));
  }
  rejected(
    inspect(root, { gitError: "config --local --get remote.origin.url" }).report,
    "repository-origin-unavailable",
  );
});

test("missing and malformed Git identity or status fail closed", (t) => {
  const root = fixture(t);
  for (const command of [
    "rev-parse --show-toplevel",
    "rev-parse --verify HEAD^{commit}",
    "rev-parse --verify HEAD^{tree}",
  ]) {
    rejected(inspect(root, { gitError: command }).report, "git-identity-unavailable-or-malformed");
  }
  for (const value of ["", "deadbeef", "not a hash", `${"a".repeat(40)}\n${"b".repeat(40)}`]) {
    rejected(
      inspect(root, { git: { "rev-parse --verify HEAD^{commit}": value } }).report,
      "git-identity-unavailable-or-malformed",
    );
    rejected(
      inspect(root, { git: { "rev-parse --verify HEAD^{tree}": value } }).report,
      "git-identity-unavailable-or-malformed",
    );
  }
  const status = "status --porcelain=v1 -z --untracked-files=normal --ignore-submodules=none";
  rejected(inspect(root, { gitError: status }).report, "git-status-unavailable-or-malformed");
  rejected(
    inspect(root, { git: { [status]: "invalid status" } }).report,
    "git-status-unavailable-or-malformed",
  );
  rejected(inspect(fixture(t, { commit: false })).report, "git-identity-unavailable-or-malformed");
});

test("missing, malformed, untracked or symlinked metadata fails closed", (t) => {
  const root = fixture(t);
  rejected(
    inspect(root, { gitError: "ls-files --error-unmatch -- package.json pnpm-lock.yaml" }).report,
    "source-metadata-unavailable-or-malformed",
  );
  for (const value of [
    "{",
    "{}",
    JSON.stringify({ ...manifest, engines: { node: "*" } }),
    JSON.stringify({ ...manifest, packageManager: "pnpm@latest" }),
  ]) {
    writeFileSync(join(root, "package.json"), value);
    rejected(inspect(root).report, "source-metadata-unavailable-or-malformed");
  }
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  rmSync(join(root, "pnpm-lock.yaml"));
  rejected(inspect(root).report, "source-metadata-unavailable-or-malformed");
  symlinkSync(join(root, "package.json"), join(root, "pnpm-lock.yaml"));
  rejected(inspect(root).report, "source-metadata-unavailable-or-malformed");
});

test("Node and pnpm mismatches and malformed or unavailable versions reject", (t) => {
  const root = fixture(t);
  rejected(inspect(root, { nodeVersion: "v24.1.0" }).report, "node-version-mismatch");
  for (const nodeVersion of ["", "22.1.0", "v22", "v22.1.0-rc.1"]) {
    rejected(inspect(root, { nodeVersion }).report, "node-version-unavailable-or-malformed");
  }
  rejected(inspect(root, { pnpm: "11.28.6" }).report, "pnpm-version-mismatch");
  for (const pnpm of ["", "latest", "11.28.7\nextra", "11.28.7-rc.1"]) {
    rejected(inspect(root, { pnpm }).report, "pnpm-version-unavailable-or-malformed");
  }
  rejected(inspect(root, { pnpmError: true }).report, "pnpm-version-unavailable-or-malformed");
});

test("explicit checkout must be the repository root, never a nested directory", (t) => {
  const root = fixture(t);
  const nested = join(root, "nested");
  mkdirSync(nested);
  const { report } = inspect(nested);
  rejected(report, "checkout-must-be-repository-root");
  rejected(sourceIdentity({ checkout: join(root, "absent") }), "checkout-unavailable");
});

test("default checkout is script-relative even when launched from another repository", (t) => {
  const caller = fixture(t);
  const script = join(SCRIPT_CHECKOUT, "experiments/letta/release-preflight.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: caller,
    env: { ...gitEnv, GIT_DIR: join(caller, ".git"), GIT_WORK_TREE: caller },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.source.commit, git(SCRIPT_CHECKOUT, "rev-parse", "HEAD").trim());
  assert.notEqual(report.source.commit, git(caller, "rev-parse", "HEAD").trim());
  assert.equal(report.qualification.installedRuntime, "unverified");
  const explicit = spawnSync(process.execPath, [script, caller], {
    cwd: SCRIPT_CHECKOUT,
    env: gitEnv,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(explicit.status, 0, explicit.stdout);
  assert.equal(JSON.parse(explicit.stdout).status, "source-identified");
  assert.equal(JSON.parse(explicit.stdout).source.commit, git(caller, "rev-parse", "HEAD").trim());
  assert.equal(git(caller, "status", "--porcelain"), "");
  const invalid = spawnSync(process.execPath, [script, "--unknown"], {
    cwd: caller,
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).status, "rejected");
});

test("CLI honors a cached project package-manager pin without enabling network access", (t) => {
  const root = fixture(t);
  const bin = mkdtempSync(join(tmpdir(), "mudfut-offline-pnpm-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // Model a Corepack shim with only the exact project pin cached. Ignoring the
  // project would need an uncached default, which must not trigger a download.
  writeFileSync(
    join(bin, "pnpm"),
    '#!/bin/sh\n[ "$COREPACK_ENABLE_PROJECT_SPEC" = "1" ] || exit 9\n[ "$COREPACK_ENABLE_NETWORK" = "0" ] || exit 10\n[ "$COREPACK_ENABLE_AUTO_PIN" = "0" ] || exit 11\n[ "$COREPACK_DEFAULT_TO_LATEST" = "0" ] || exit 12\nprintf "11.28.7\\n"\n',
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    [join(SCRIPT_CHECKOUT, "experiments/letta/release-preflight.mjs"), root],
    {
      cwd: SCRIPT_CHECKOUT,
      env: { ...gitEnv, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "source-identified");
  assert.equal(report.versions.pnpm.observed, "11.28.7");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("preflight imports only Node builtins, not production/runtime/network modules", () => {
  const source = readFileSync(new URL("./release-preflight.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.ok(imports.length > 0);
  assert.ok(imports.every((specifier) => specifier.startsWith("node:")));
  assert.ok(!/\b(?:fetch|import)\s*\(/.test(source), "no dynamic or network loading");
});
