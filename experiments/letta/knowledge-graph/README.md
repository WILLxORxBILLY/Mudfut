# Local community knowledge atlas

A read-only, loopback-only explorer over the existing Letta pilot PostgreSQL
records and optional historical archive. PostgreSQL remains authoritative. There
is no graph database, schema migration, model call, ingestion job or bot sender.
Refresh rebuilds a disposable snapshot from existing records.

From the repository root, use Node 22 and install this checkout's dependencies:

```sh
pnpm install --frozen-lockfile
pnpm letta:graph --demo
```

Open <http://127.0.0.1:4317>. The demo is entirely fictional, including its coverage
numbers, names and IDs. Meet **Juniper Commons**: six fictional neighbors planning
an observatory trip, rooftop garden, little library and repair café.

Four guided examples open a useful neighborhood and its evidence inspector:

1. **A preference, corrected** — compare Mira's original broad label with its
   narrowed revision; the old understanding and accepted correction remain visible.
2. **When the source changes** — compare Rowan's bound morning-train message
   with its edited afternoon-train version; the interpretation stays marked stale.
3. **One garden, two priorities** — inspect Sana's and Jules's competing spending
   proposals with each perspective attributed to its speaker.
4. **How much is understood?** — filter five fictional channels across three months;
   stored, reviewed and represented counts overlap and never imply full coverage.

Use **Show whole map** to explore freely. Search across source text and annotations,
filter types/statuses, or select a person/topic to follow recorded connections.
Dragging empty map space pans; the zoom slider and **Fit map** work without gestures.
Use Tab then Enter/Space on map nodes, or the record list, to inspect them. Compact
screens also offer **Read the selected evidence** to jump directly to the inspector.
The shape/color legend distinguishes people, messages, claims, interpretations and
topics. Dashed edges mark context, competition and revision links; every edge has
its recorded relation in the inspector. Layout proximity has no independent meaning.

To inspect an existing installation, set the configuration directory outside the
repository instead:

```sh
MUDFUT_STATE_DIR=/absolute/private/state pnpm letta:graph
```

The directory must contain `postgres.json`, the existing pilot `pg.Client`
configuration, and optionally `history-postgres.json`, the existing archive
reader configuration. Each must be a private regular file (mode `0600`, no
symlinks). Do not put credentials or real snapshots in this repository. The
adapter never returns database configuration or raw database errors to the
browser. It opens no Discord or model connection. `KNOWLEDGE_GRAPH_PORT` can
select a different loopback port; the host is always `127.0.0.1`.

The existing application roles can read through this adapter because every
transaction begins `REPEATABLE READ READ ONLY`, with a 10-second statement
timeout, 1-second lock timeout and 15-second idle transaction timeout. It does
not call schema-initializing store factories or acquire worker locks. The pilot
and archive snapshots are separate transactions; the timestamp is capture time,
not a cross-database atomic checkpoint. Prefer dedicated SELECT-only credentials
when provisioning a separate installation; this feature does not provision roles
or change existing permissions.

The HTTP service accepts only same-origin GET requests to an explicit asset/API
allowlist, checks the loopback Host, rejects cross-site requests, sends a restrictive
content security policy, and disables response caching. Private source text is
served only to the local browser. This is a single-user local tool; do not proxy
it onto a public or shared network. A hosted service would require its own
reviewed authentication, access and deployment design.

## Explore and inspect

- Search labels, names, topics, original content, quotations, qualifications and
  correction details. Filter by node type or annotation/evidence status.
- Select a node or keyboard-accessible record button to open its inspector.
  “Focus connections” clears filters and shows one or two recorded hops. Zoom
  and scroll the map; page through the record list in groups of 100. All records
  remain reachable even when the map is bounded.
- Person and topic nodes connect to original messages and attributed candidates.
  Each candidate revision is a separate node. Individual anchored claims remain
  distinct from both the candidate and original source message.
- Inspect exact quote spans, attribution, bound source revision, current source
  revision, direct/context role, qualifications, uncertainty, correction notes
  and annotation chronology. Open the original Discord message via a validated
  numeric citation, or inspect its local stored record.
- Support, qualification, contradiction and context edges come from recorded
  anchors. “Said” and “replies to” come from source metadata. “About” and topic
  links come from annotation fields. These are not inferred social ties, and
  recorded claim relationships are still attributed interpretations. No model
  infers friendship, agreement or other social relationships.
- Same-ID revision links have exact predecessor identity. `competingWith` and
  `supersedes` store annotation IDs without a revision: those edges explicitly
  say “identity (latest revision)” and resolve the latest retained version for
  navigation, rather than claiming an exact historical revision binding.

Evidence status compares stored source revision, generation and correction
generation with the committed annotation job receipt, verifies exact quotes and
claim-anchor attribution, and marks missing, deleted or mismatched records. A
missing job binding is unknown. A historical quote can remain exact in its bound
revision while its current source is stale. The explorer does not perform live
Discord edit/deletion checks. “Matches stored revision” is deliberately weaker
than current source availability on Discord. Existing workers continue to own
validation, learning and correction writes; refreshing this UI never repairs data.

## Coverage accounting

The dashboard separates these overlapping measurements:

| Measurement                   | Evidence and denominator                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored archive rows           | All rows in the available `messages` table, grouped by stored guild/channel and UTC month. This is an archive denominator, not a server inventory.                                                                                                                                                                                  |
| Usable archive text           | Nondeleted, nonblank text rows outside threads.                                                                                                                                                                                                                                                                                     |
| Reviewed targets              | Distinct `read_ids` in done history episodes linked to the matching done historical work. The worker commits these receipts only after revision-checked memory write/recovery. Unchanged-memory reviews need no new memory commit. `learned=true` is never used. This is historical review, not proof that later edits were reread. |
| Loaded context                | Distinct `context_ids` from those same completed episodes, counted separately from review targets.                                                                                                                                                                                                                                  |
| Represented direct sources    | Distinct `candidate.sourceIds` in current candidate annotations. The annotation table's dependency `source_ids` includes context and must not substitute for direct evidence. Stale/unavailable candidates still count as represented; their status is exposed in the graph.                                                        |
| Selected                      | Distinct direct/context pins in installed knowledge manifests. Selection does not establish review.                                                                                                                                                                                                                                 |
| Deferred                      | Distinct selected target IDs in deferred episodes. Deferred and excluded episodes do not establish review.                                                                                                                                                                                                                          |
| Usable without review receipt | Usable archive rows whose IDs have no matching committed historical-review receipt. This does not assess message relevance.                                                                                                                                                                                                         |
| Conversational memory         | Current `pilot_memory_entries` count, separately from annotation/claim counts.                                                                                                                                                                                                                                                      |

Channel/month cells reconcile receipt IDs against actual archive message IDs.
The summary reports reviewed IDs absent from the available archive. The pilot
cache range is shown separately because it can be newer than the archive. Counts
may overlap across stages and must not be added into a processing funnel.

Complete channel inventory, missing historical intervals, inaccessible channels,
thread completeness, attachment content and the latest Discord edits/deletions
remain unknown. The adapter does not query backfill checkpoints or invent missing
channel names. Archive connection/permission failures become an explicit
unavailable state with unknown counts, while the pilot graph can remain usable.

## Limits and checks

```sh
pnpm letta:graph:check
pnpm format:check
```

The focused built-in Node check covers historical evidence and corrections,
quote/attribution mismatch, missing and stale sources, context-only boundaries,
exact focus hops, filters/pagination, direct-source accounting, read-only
transactions, rollback, HTTP host/origin isolation and error redaction. It uses
only fictional records; it does not need private configuration, a live database,
Discord, paid models or a test framework. The PostgreSQL adapter uses the existing
schema; installations without it receive a sanitized 503 instead of automatic
initialization.

The initial adapter deliberately refuses oversized snapshots rather than silently
truncating: 2,000 annotation versions, 5,000 selected current sources/jobs/corrections,
10,000 retained source revisions, 1,000 manifests, 50,000 combined history-stage IDs
and 10,000 archive channel/month buckets. Aggregate archive queries read metadata
and counts rather than transferring the corpus. Scaling beyond these bounds
needs server-side keyset pagination and per-neighborhood queries; the UI already
pages the projected records. No unbounded backfill or historical model sweep is
started. Browser tab closure does not stop the adapter; use Ctrl-C in its terminal.
