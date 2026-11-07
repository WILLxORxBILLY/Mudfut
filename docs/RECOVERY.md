# Persistent provisional recovery gate

The recovery gate restricts an installation while an earlier database state is
being qualified. It is not a recovery importer, a new memory authority, a backup,
or permission to activate a bot. It does not reconstruct missing work, memory
revisions or delivery receipts, and release does not declare missing state lost.

## One policy, two restricted phases

The database owns the policy and its release history. A policy binds an explicit
baseline identifier and protected source IDs. Restarting the process must not
remove that restriction.

| Policy                           | Permitted behavior                                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No recovery policy               | Ordinary installation behavior.                                                                                                                                                                                                                                                             |
| Held                             | Fail closed before normal startup effects, external callbacks, source changes, work, memory, delivery and historical intake. Read-only inspection and deliberate policy administration are separate.                                                                                        |
| Explicitly released to live-only | Permit only authorized fresh live intake beyond explicit per-route frontiers, plus read-only archive recall. Protected sources, historical intake, memory derivation and global rebuild paths remain denied. An absent or new route is not implicit permission to fetch its recent history. |

Release must match the current policy revision and include an explicit reason and
route-frontier selection. A stale or malformed release must not change policy or
protected state. Release is audited; it is not a casual delete/clear operation or
an automatic transition back to unrestricted processing.

## Read-only archive recall

Live-only also opens the separate read-only archive role, so an operator can read
retained Discord discussion without re-opening replay. The gate distinguishes the
kinds `assertRecovery` accepts:

- `archive` is the only kind added for this purpose. It is permitted under
  live-only and still rejected under held.
- `history`, `operator`, `reset`, `migrate`, `edit` and `remove` remain rejected
  for the whole live-only phase, exactly as before.

An archive read is not intake. `archiveTool`, `archiveDiscussions`,
`browse_archive`, `read_discussion` and `search_archive` return freshly validated
Discord originals with `recovery.persisted: false`; they do not ingest sources,
write tombstones, enroll history episodes or feed the memory evidence set. The
archive client itself is constructed only for live-only: under held it does not
exist, and `recoverHistoryDerivation` plus the `learning.next()` admission guard
still return `recovery-disabled` for any policy. A readable archive therefore does
not permit deriving remembered state.

The source API is in `experiments/letta/pilot-recovery.mjs`:

- `holdRecovery(db, { baseline, protectedSourceIds, reason })` establishes the
  initial held policy. `baseline` is a 64-character lowercase SHA-256 identifier,
  not a claim that the identified state is complete or independently backed up.
- `releaseRecovery(db, { expectedRevision, reason, frontiers, confirmLiveOnly })`
  requires `confirmLiveOnly: true` and an explicit channel-ID → message-ID frontier
  map. It retains the baseline/protected set and historical denial.
- `readRecoveryPolicy(db)` inspects policy without activating anything. Only an
  absent policy table means ordinary mode; an empty or invalid table fails closed.
- `archiveAccess(policy)` reports whether the worker may hold an archive connection
  and which gate kind its per-call preflight uses.
- `historyDerivationDisposition(policy)` returns `recovery-disabled` for any policy,
  so derivation stays shut while recall is readable.

These are installation primitives, not authorization to call them against a
recovered database. Establishing a hold creates policy/audit tables and write
guards on existing `pilot_*` tables in the current schema. Privileged schema
changes or new tables outside that coverage are not automatically fenced; schema
compatibility and the actual installation still require qualification.

Disabling automatic history admission is insufficient: already queued episodes,
manual selections and historical completion paths also need the same gate.
Likewise, setting `learnable=false` is not durable quarantine: ordinary source
re-observation can promote that flag, and source holds alone do not prevent an
edit from scheduling a global rebuild. The recovery policy must be checked before
those effects, not merely before selecting a reply.

## Reply evidence

`validation_ids` name the sources a reply cites. A citation must name a source
that exists, but it is not required to sit inside the released frontier:
gating citations refused every reply that cited pre-frontier memory. Enrolment
is governed by `source_ids` only — `validation_ids` are never enrolled,
derived, or sent. A reply citing memory from before the frontier is committed;
a reply deriving new work from a pre-frontier source is not.

`prepare`-phase failures are retryable unless they are a genuine recovery
refusal, so exit code 78 is reserved for real refusals and a retryable
prepare failure exits 75. A terminal worker exits within two seconds of
finishing, rather than lingering on an unresolved handle until the
supervisor's watchdog signals it.

## Ownership and boundaries

Startup must establish the database session's single-writer ownership before
Discord identity checks, archive access or model callbacks. Existing session
objects must not bypass a policy established after they were created. Policy
lookup errors and malformed persisted policy fail closed rather than silently
selecting ordinary mode.

Live-only is deliberately conservative. It is not permission to replay old
cursors, enroll an unknown route silently, resume historical work, or invalidate
the retained baseline through source edits/removals. This may defer otherwise
ordinary operations until a separately qualified decision permits them. Normal
installations without a recovery policy retain their existing behavior.

The gate is an application control for the existing single-writer contract, not
a security boundary against an administrator who can alter the database/code. It
does not establish multi-writer transaction fencing or recall an HTTP request
already in flight. A fixture proving lock exclusion is not a live supervisor or
credential-ownership qualification.

Manual staging commands now consult the pilot database before archive access or
request-file writes, so that database and its private connection configuration
must be available even for staging. An unavailable policy check is not permission
to stage offline. Read-only inspection remains separate. Without a recovery
policy, ordinary history selection can still stage for a running worker; it does
not become a second memory writer.

## Before operational use

Source and synthetic fixture results do not qualify a recovered runtime. Bind
the approved source/tree, locked dependencies, toolchain, private configuration
and exact database candidate before any separately authorized installation.
Retain original state and unresolved evidence. Require an independent backup and
successful restore test before promotion; another copy on the same disk is not
that backup.

Test against a fresh disposable database, never by invoking schema-writing
factories against an operator's state. Installation, backup writes, candidate
promotion, route-frontier changes and live activation require their own explicit
scope. On a failed trial, stop the owned candidate and retain its evidence; do not
reverse-copy it into originals or automatically enable catch-up.
