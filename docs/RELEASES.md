# Release foundation

This is the first source-identity step, not a completed CI/CD system. PR CI
records source identity after the existing model-free and disposable PostgreSQL
checks. A passing preflight does **not** qualify a release, prove an installed bot
is running this source, or authorize a deployment.

The JSON report is retained in the CI step log, not published as an artifact.
For PR checkouts, its commit may be GitHub's synthetic merge SHA rather than the
PR head SHA. The report's qualification fields remain `unverified`; only the
workflow conclusion establishes whether the CI checks passed.

## Inspect local source

With Node 22 and the repository's pinned pnpm already available:

```sh
pnpm --silent release:preflight
```

The command prints a JSON report and exits zero only for `source-identified`.
Use `--silent` to suppress pnpm's script banner when consuming stdout as JSON.
Without an argument, it examines the checkout containing the script, regardless
of the caller's working directory. To inspect another local checkout explicitly:

```sh
pnpm --silent release:preflight /absolute/path/to/checkout
```

The explicit path must be the Git repository root, not a nested directory.
This is source inspection, never discovery of a live installation. No state
directory, credentials, database, service manager, model, or Discord connection
is inspected or contacted. No Git writes, dependency installation, fetch, push,
tagging, service start or restart is performed. Commands are limited to local
Git inspection and `pnpm --version`; Corepack network access is disabled. Git
filesystem-monitor hooks and optional index writes are disabled, and inherited
Git directory/config overrides cannot redirect the inspection.

The report includes:

- Canonical repository identity `WILLxORxBILLY/Mudfut`, accepted only from direct
  GitHub HTTPS, SSH URL or SCP-style SSH `origin` forms. Credential-bearing
  URLs, other hosts and other repositories are rejected. Raw origin URLs and
  subprocess diagnostics are never emitted.
- Full Git commit and tree object IDs, with tracked and untracked dirty flags.
  Filenames and file contents are not included. Ignored files are outside this
  source check; keeping runtime state outside the repository remains mandatory.
- SHA-256 of `pnpm-lock.yaml`; both it and `package.json` must be tracked regular
  files. This identifies lockfile bytes, not installed dependency integrity.
- Required and observed Node and pnpm versions. The current manifest requires
  Node `22.x` and exact pnpm `11.28.7`. Node's major must match; pnpm must match
  exactly. Observed versions belong to this inspection process/host only.

Missing or malformed Git identity, absent/wrong origin, dirty source, unavailable
or malformed metadata/versions, and version mismatches fail closed with stable
error codes. Unsupported requirement syntax also fails closed rather than
silently approximating semver. Rejected reports may have null fields; never treat
a partial report as success. `ci`, `installedRuntime`, and `deployment` remain
`unverified` even on success. An uncommitted development checkout is expected to
fail: do not hide changes merely to obtain a passing report.

This is a local observation of a trusted checkout, not signed provenance,
remote repository verification, a tamper-proof attestation, or an atomic
snapshot against concurrent edits. Local Git configuration and executable
provenance are not audited. Do not edit the checkout during inspection. Source
inspection does not prove installed dependencies match the lockfile, patches
are applied, PostgreSQL is available, credentials work, or a bot is healthy.

## Deliberate release process roadmap

Only the source check above and its CI step-log recording are implemented here.
The following gates remain future work, not promises made by `source-identified`:

1. **PR CI qualification.** Run the existing model-free source checks and
   disposable PostgreSQL fixture checks for the exact reviewed commit. Record
   workflow/check identity and results; do not bring operator state or credentials
   into CI. Passing local inspection cannot substitute for these checks.
2. **Immutable candidate.** Bind the qualified commit/tree, lockfile digest,
   runtime/package-manager requirements and patch/dependency evidence to an
   immutable release candidate. Define publication, provenance, and approval
   policy before creating tags or artifacts; a mutable branch is not a candidate.
3. **Deliberate, state-compatible deployment.** Require operator approval and an
   explicit installation identity and target. Check current/target versions,
   schema and state compatibility, backup/recovery readiness, configuration and
   permissions. Preserve one writer per installation and separate source from
   private state. Never infer deployment from a developer checkout or run an
   automatic `git pull`/restart against a live bot.
4. **Health and receipt.** After an authorized deployment, check the intended
   installation, worker/database health and exact running candidate. Produce a
   non-secret deployment receipt tying installation identity, candidate, checks,
   time and result together. Live model/Discord proofs require separate explicit
   authorization and are not ordinary CI or preflight checks.
5. **Rollback.** Retain the previous immutable candidate and a tested recovery
   plan. Roll back only after checking schema/state compatibility; restoring old
   code is not inherently safe after state changes. Define pause, backup restore,
   single-writer and verification procedures before deployment automation.

Installation and current manual operations are documented in
[INSTALL.md](INSTALL.md) and [OPERATIONS.md](OPERATIONS.md). This foundation does
not replace them or alter their services.
