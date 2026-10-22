# Architecture

The first public release contains the current Letta bot and knowledge atlas.
The `experiments/letta` directory name is retained to avoid rewriting relative
imports and established checks; it does not point to another checkout or server.
All application modules and synthetic tests are in this tree.

`pilot.mjs` owns live polling, current-source validation and durable work.
`pilot-store.mjs` owns source/work/delivery state and the single-writer lock.
`pilot-memory-postgres.mjs` preserves append-only understanding revisions.
`pilot-model.mjs` supplies bounded application tools to the Letta SDK; the model
has no shell, filesystem, browser, other agents or native execution tools.

Historical selection and recovery live in `pilot-history.mjs` and
`community-knowledge-recovery.mjs`. A committed eligible candidate is bound to
its immutable manifest, exact source/context revisions, correction generations
and archive authority. Recovery projects that candidate without another model
call. Stale bindings cannot silently replace newer interpretations.

`community-knowledge.mjs` stores candidate annotation revisions, quote spans,
claim anchors, corrections and derived person/topic/history views. Candidate
prose is not original evidence. Source edits, deletions and interpretation
changes invalidate their dependent current views and work.

The `knowledge-graph` directory reads those records through bounded read-only
transactions and renders a disposable browser snapshot. It preserves revision
identity, direct/context roles, quotations and recorded claim relationships.
Coverage reconciles committed review receipts with stored archive IDs; it does
not infer that an archive is a complete inventory of Discord.

Private configuration and runtime state live outside the checkout. The archive
is optional and has a separate reader role. The public demo and ordinary checks
use fictional data; production deployments, credentials and real evidence are
not release inputs. There are no migrations from a maintainer's private server.
