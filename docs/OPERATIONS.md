# Operations

`pnpm start` runs the bounded supervisor in the foreground. SIGINT/SIGTERM request
cleanup; do not clear worker locks or recovery state to force a second writer.
A held failure needs inspection of its private receipts and a deliberate resume.
The supervisor deliberately exits with status 0 on a held or blocked startup to
prevent the optional LaunchAgent from restarting it indefinitely. A zero exit
therefore does not establish readiness; inspect the error, private receipts and
`pnpm bot:status` when its configuration and database are available.
Preserve both the current database and any prepared work/unsent delivery before
changing routes or restoring a backup. Do not restore an old database snapshot
over newer memory without quantifying the data-loss interval.

The `pilot-service.mjs` installer is an optional macOS user LaunchAgent. It is
not a portable Linux service manager; use foreground operation or your own
reviewed service configuration elsewhere. Its default service identity supports
one installation per macOS user. Do not run install/start/stop/resume against an
existing installation merely to test the source checkout.

The LaunchAgent reads the checkout's optional `.env` on each start, including
`MUDFUT_MODEL` and `MUDFUT_PERSONA_STYLE_FILE`, like `pnpm start`. Its installed
state directory and renewable authentication mode take precedence over `.env`.
Existing LaunchAgents need a deliberate stop and reinstall to adopt changed
startup arguments; updating source alone does not rewrite an installed service.
The configured model is used when creating an agent; editing `.env` does not
switch an existing agent to another model. On worker startup, a changed persona
or style updates the existing agent's system prompt. The agent identity, saved
model and memory are retained.

`pnpm bot:status` prints a JSON report from a read-only transaction over the
existing pilot tables; it does not initialize an installation, contact Discord,
call a model, or acquire the memory-writer lock. Each configured destination
lists its last successful and failed poll, pending addressed messages, ready,
in-flight or held replies, and its latest recorded delivery. Forum rows include
active discussion counts and individual retained thread states. Missing poll
evidence is `unobserved`, and old evidence is explicitly stale. A configured route
or successful read does not establish send permission or a delivered reply.
Delivery links come from local Discord acceptance receipts; the report does not
recheck whether those messages still exist. Keep this output private.
Freshness uses the default worker watchdog's four-minute interval; timestamps
remain visible. Delivery records that cannot be assigned to a configured route
are reported separately, including any that require inspection.

The worker stores poll metadata in private `channel-polls.json` and archive
availability in `archive-status.json`. Runtime progress, route access and delivery
are separate observations. `pnpm knowledge report` reports bounded knowledge state.

Correction cases retain their original records and receipts. A Discord correction
is identified by target source, note, origin, reporter and reporter message; replaying
that message remains idempotent even after the target is edited. A different message,
reporter, note or origin creates a separate case. Requests without a reporter message,
including private-operator requests, are also keyed by the target source revision,
so the same request after an edit creates a fresh case. A closed case is not reopened
by replaying the same identity. Reporter messages must still pass current-source
validation before a retry is accepted. If a reporter message is removed or edited
so it no longer matches its case, the case is retained as unavailable with an audit
receipt; a matching new message or amended request can be reviewed independently.

Stored annotation records are preserved. If a legacy candidate contains a quoted
span that does not occur in its current source, current views withhold that
candidate and report incomplete evidence; old prepared exports containing such
quotes are rejected. Inspect the retained source and annotation before review.

The database initialization migrates the former source-and-note uniqueness constraint
atomically without changing correction rows or receipts. Once multiple cases share a
source and note, older software that assumes the former constraint cannot safely be
used for rollback; preserve the records and use compatible software or a separately
reviewed migration. This code change alone does not deploy or migrate a live database.

An endpoint message read that reports Missing Access, Missing Permissions, or
Unknown Channel leaves that channel's cursor unchanged while healthy channel
polls continue. A channel without a cursor retains quiet initial catch-up when
access returns. Other read errors and startup, discovery, source-validation,
delivery, or local-state failures retain their existing recovery safeguards.

An optional archive connection or query failure pauses that reader for the rest
of the worker process. Background history remains unread and its saved cursors
are retained; live polling and replies using available evidence continue. Archive
tools explicitly report unavailable evidence rather than empty or exhausted
search results. Inspect `archive-status.json`, repair the archive/index/access
problem, then stop and start the worker to retry. A native memory database,
prepared-candidate, or ambiguous-delivery failure keeps its existing recovery
safeguards; an archive pause does not authorize clearing a worker or delivery hold.
Archive `connected` means only that a connection opened; `available` records a
successful read, and `paused` records a failure requiring repair and restart.

For a route change, stop the current worker and inspect prepared memory, unsent
output and any other runtime using the same Discord identity. `pilot-route.mjs`
provides a guarded plan/switch command with a private backup and receipt for
single-channel installations. It refuses to replace a multi-channel scope. A local
PostgreSQL lock cannot coordinate a separate remote bot runtime.

Take and validate PostgreSQL backups using your own private credentials and
retention policy. Test recovery against isolated data. Synthetic checks exercise
recovery logic but are not evidence that your deployment's backup is restorable.

Dependency containment remains in `.pnpmfile.mjs` and `patches/`. The pinned Letta
bundles have unused MCP OAuth entry points disabled by that reproducible patch;
ChatGPT provider renewal is separate. The sharp-electron dependency resolves to
patched sharp for this Node-only application. Electron embedding is unsupported.
Retain these protections until a verified upstream upgrade replaces them.

The explicit Zod 4.6.7 dependency selects compatible declared peers. Reproducible
patches also bound array parsing in five installed Letta bundles: three CLI
artifacts and both SDK versions. They reject oversized inputs before reading
children only for declared leading upper bounds. Unbounded arrays, custom checks
before a bound and overall input bytes remain outside this patch. Embedded 4.4.3
version markers remain intact. Early-bound errors preserve the embedded serializer's
existing issue shape and custom error maps without adding a public schema field.
Root Zod v3 compatibility remains callable if an
external caller supplies a v3 schema; this change makes no full CVE-remediation or
live-runtime claim. Replace these patches with verified upstream rebuilt artifacts.
`node experiments/letta/bundled-array-bounds.test.mjs` checks the actual installed
constructors offline without importing Letta executables or calling a provider.

The pinned upstream CLI currently reports React peer-version warnings for its
terminal UI dependencies. This release uses its headless local SDK path and does
not claim support for embedding that terminal UI or Electron. The headless fixture
checks pass; those warnings are not presented as a clean peer-dependency audit.

## Offline coverage and provenance inspector

`pnpm coverage:inspect /private/coverage.json /private/coverage-report.html`
renders one private audit snapshot into a self-contained operator report. Add
`--open` to open that HTML file with the operating system. It needs Node 22 only:
no database credentials, bot process, model, web server or external assets. It
never recollects evidence or writes runtime state. Output uses mode `0600` and
must be a new path outside the repository; existing reports are preserved.

The input must be a private regular JSON file outside the repository (no symlink,
maximum 16 MiB), with `schemaVersion: "mudfut-coverage-v1"`. The collector owns the
counts and evidence. This viewer validates their shape; it does not independently
prove a review or substitute archive availability for learning. Regenerate from a
new collector snapshot to see changed state. Capture timestamps and snapshot age
remain visible; a report over 24 hours old is explicitly marked as old.

The snapshot contract is metadata only:

- `generatedAt`: ISO timestamp with timezone. `capturedAt` contains ISO timestamps
  or `null` for `archive`, `native` and `cloudProof`; store snapshots may differ.
- `scope`: bounded metadata describing actual collection, enrollment and reply
  scope, explicit policy exclusions, inventory completeness and denominators.
- `summary`: independent source counts, each a nonnegative integer or `null`.
  Supported keys are `archived`, `searchable`, `reviewedExactCurrentRevision`,
  `reviewedStaleRevision`, `reviewUnknownRevision`,
  `reviewedTemporalCurrentCandidates`, `unreviewed`, `retainedProvenance`,
  `pending`, `unknown` and `excluded`. Missing values display **Unknown**.
- `channels`: up to 2,000 records with `id`, optional `name`/`parentId`,
  `scope` (`archived`, `policy-excluded` or `native-only`), `metrics`, `notes`,
  and `sources`. Optional `sourcesComplete`, `sourcesLimit` and
  `sourcesSelection` describe the exported drill-down selection.
- `sources`: up to 10,000 details across channels, each with `id`, optional
  validated Discord `url`, timestamps `createdAt`/`currentEditedAt`/`reviewedAt`,
  `currentContentHash`, `archiveState`, `reviewStatus`
  (`current`, `stale`, `unknown-revision`, `unreviewed`), optional
  `reviewDecision` (`retained`, `irrelevant` or `null`), `proof` (method string or
  `null`) and `retainedProvenance` counts `currentEntries`/`historicalVersions`.
  Current review requires `proof: "direct-immutable-binding"`.
  `"temporal-reconstruction-only"` must remain `unknown-revision`.
- `sourceCoverage`: `{included, totalKnown, selection, complete}` describes the
  number of exported source details, known denominator (integer or `null`),
  selection method and completeness for that stated scope. Optional
  `definitions` is an array of `{key, label, description, unit}` for the supported
  metrics. Optional `freshness` contains bounded collector reconciliation metadata.
  `limitations` is a required array of accounting qualifications.

Use channel buttons, search and review-status filters to inspect source metadata
and retained-memory citation counts. The report has no memory text or original
message bodies. Exact-current review, earlier-revision review, revision-unknown
receipts and temporal reconstruction remain separate evidence tiers. Temporal
reconstruction is an overlapping tier within revision-unknown review; it is not
upgraded to direct proof. Retained provenance does not prove exact-current review.
Pending and excluded evidence do not establish completion. Parent/thread rollups
and the other measures can overlap, so the report never sums them into an
exclusive funnel or invents a full-server completeness percentage.

The report embeds safely serialized metadata, uses `textContent` for display and
allows only its exact hashed script/style under a restrictive content security
policy. It makes no network requests; validated Discord links open only on click.
Keep both JSON and HTML private, because source IDs, hashes and provenance metadata
can still be sensitive. Larger selections need paginated collector exports; this
viewer intentionally refuses oversized input instead of silently truncating it.

`node experiments/letta/coverage-inspector.test.mjs` is the focused assert-based
selfcheck for invalid metadata, tier confusion, XSS serialization and CSP hashes.
It contains inline canaries only and does not read operator state.

## Incomplete observation decisions

A successful model result must still include valid explicit memory decisions for every
input target. Missing decisions never mark sources learned or create an outbox reply.
Live turns now retain a PostgreSQL retry receipt for each exact source revision,
wait 30 seconds after the first incomplete attempt and two minutes after the second,
and supply an explicit repair instruction on retry. Other messages continue normally.
After three incomplete attempts that revision is held for inspection rather than
restarting the whole worker or retrying forever. `pnpm bot:status` lists
`generationFailures` and adds `live-generation-held-requires-inspection` to `attention`.
The original message stays unlearned. A real source edit gets a new revision budget;
restarting the worker does not reset it. Do not edit a source or erase a failure receipt
to bypass a hold. Diagnose the model/tool failure before an operator-approved retry.

The additive `pilot_generation_failures` table stores only source identifiers, source
hashes, counts and timestamps. Existing memory, revisions, work and delivery receipts
are preserved. Old releases ignore this table but also lack its failure isolation;
rolling back restores the previous restart behavior. Authentication, database,
source-validation, cleanup and delivery errors retain their existing safety handling.
Historical and operator work retain their existing independent retry policies.
