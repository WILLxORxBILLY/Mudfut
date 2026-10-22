# Operations

`pnpm start` runs the bounded supervisor in the foreground. SIGINT/SIGTERM request
cleanup; do not clear worker locks or recovery state to force a second writer.
A held failure needs inspection of its private receipts and a deliberate resume.
Preserve both the current database and any prepared work/unsent delivery before
changing routes or restoring a backup. Do not restore an old database snapshot
over newer memory without quantifying the data-loss interval.

The `pilot-service.mjs` installer is an optional macOS user LaunchAgent. It is
not a portable Linux service manager; use foreground operation or your own
reviewed service configuration elsewhere. Its default service identity supports
one installation per macOS user. Do not run install/start/stop/resume against an
existing installation merely to test the source checkout.

`pnpm bot:status` reads the existing pilot tables (it does not initialize a new
installation). `pnpm knowledge report` reports bounded knowledge state. The
standalone graph never acquires the worker lock or initializes schema.

For a route change, stop the current worker and inspect prepared memory, unsent
output and any other runtime using the same Discord identity. `pilot-route.mjs`
provides a guarded plan/switch command with a private backup and receipt. A local
PostgreSQL lock cannot coordinate a separate remote bot runtime.

Take and validate PostgreSQL backups using your own private credentials and
retention policy. Test recovery against isolated data. Synthetic checks exercise
recovery logic but are not evidence that your deployment's backup is restorable.

Dependency containment remains in `.pnpmfile.mjs` and `patches/`. The pinned Letta
bundles have unused MCP OAuth entry points disabled by that reproducible patch;
ChatGPT provider renewal is separate. The sharp-electron dependency resolves to
patched sharp for this Node-only application. Electron embedding is unsupported.
Retain these protections until a verified upstream upgrade replaces them.

The pinned upstream CLI currently reports React peer-version warnings for its
terminal UI dependencies. This release uses its headless local SDK path and does
not claim support for embedding that terminal UI or Electron. Installed-package,
headless fixture and graph checks pass; those warnings are not presented as a
clean peer-dependency audit.
