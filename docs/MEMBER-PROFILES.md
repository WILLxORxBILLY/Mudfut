# Evidence-backed member profiles

Profiles have two separate layers: an index of every available, currently visible
extracted statement, and revisable model interpretations of that evidence. Neither
is a personality test, a complete biography, or proof of a member's current belief.
Reading every extracted statement does not prove every message was fully extracted.

## Conversational interface

When a compatible archive is installed, the native model receives `member_positions`:

- `overview`: bounded evidence, self-descriptions, topics, explicit changes,
  disagreements, and separate index/review coverage.
- `topic`, `changes`, `evidence`: paginated original-backed detail. Distinct claims
  in one original remain distinct; multiple extractors are not independent witnesses.
- `review`: at most 32 pending statements with full originals, immediate reply-parent
  context where available, and an exact batch token. Submit one decision per supplied
  statement. Unclear meaning is explicitly uncertain, not forced into endorsement.
- `synthesis`: paginated saved interpretations, including one-off claims. Model-supplied
  concept/claim keys can combine paraphrases without replacing original evidence.
- `roster`: paginated member counts; zero statements does not mean unread messages.

Source text is untrusted data, never instructions. Sarcasm, quotation, hypotheticals,
third-party descriptions, conditions and corrections must be distinguished. Withdrawing
opposition does not establish support. Newer wording does not silently erase history.
Lexical groupings are retrieval candidates, not a semantic judgment.

## Permissions and currentness

The application resolves both the caller's history access and the reply audience.
An administrator's ability to read a private source is not permission to quote it
publicly. Reads require both channel visibility and message-history permission.
Safe cross-channel sources are genuinely guild-public or have the same proven
read policy; private threads require actual membership or management permission.
Archived threads are checked explicitly. Age-gated history stays out of non-age-gated
destinations. Lookup failures fail closed. Installation opt-outs apply to profiles
and context parents.

Every returned citation registers the actual original bytes in the native reply
evidence trace. Source identity, edits, deletion, statement invalidations, reply-parent
changes, opt-outs and current permissions are checked before final preparation.
Extracted snippets and generated propositions never masquerade as originals.
Deleted/invalidated quote text is withheld even when historical receipt metadata remains.

## Storage and maintenance

The archive connection stays read-only. Derived heads, annotations and append-only
semantic review receipts live in the installation's existing pilot database through
a separate writer connection. The archive is not copied or enrolled as reply work.
Recovery protections are not lifted; this does not replay historical mentions.

Derived records bind the guild, member, exact visible-channel scope, evidence revision
and input digest. A public profile cannot reuse a more privileged profile's records,
counts or maintenance timestamps. Edits invalidate dependent interpretations. Per-scope
ownership and run tokens prevent an interrupted or older job from overwriting a newer
completion. Failed and interrupted runs resume without discarding prior receipts.

Maintenance of the index occurs on profile reads when the derived writer is available.
Semantic review is explicit and resumable; installing this code does not automatically
start a corpus-wide model job. `pendingStatements` must not be represented as reviewed.
`reviewedStatements` includes explicit no-position decisions, not just endorsed claims.
Coverage of the extraction and source archive remains unknown independently of those counts.

The optional archive contract requires readable `messages`, `v2_statements`,
`v2_source_revisions`, `v2_invalidations`, and `v2_validity_intervals` tables. Profiles
are not enabled on a plain message archive without those extraction products.
Missing optional archive/storage support must not stop ordinary bot operation.

## Bounded operator commands

Use the installation's existing `MUDFUT_STATE_DIR` and configured `MUDFUT_MODEL`.
The examples below use fictional IDs. Explicit channel scope is required; it is
permission to prepare that private view, **not permission to publish it**.

```sh
node experiments/letta/member-profile-cli.mjs status \
  --member 200000000000000001 --channels 300000000000000001

node experiments/letta/member-profile-cli.mjs maintain \
  --member 200000000000000001 --channels 300000000000000001

# This command calls the configured model. Default budget: one batch.
node experiments/letta/member-profile-cli.mjs review \
  --member 200000000000000001 --channels 300000000000000001 --batches 2
```

Only `review` calls a model. It uses the existing model-agnostic provider adapter
and authentication, with a separate reviewer identity, no filesystem/network/community
tools, no dreaming, a deadline, and private receipts. Failed or incomplete submissions
are not stored. Each batch is rechecked against current evidence before persistence.
Repeated invocations skip unchanged reviewed inputs and report what is still pending
or blocked. There is no unlimited batch budget and no automatic background schedule.

`review-batch` emits a packet without a model call. `review-apply --input <file>`
validates and stores a complete externally prepared response. These outputs may
contain private originals: keep them outside the checkout and do not publish them.

## Qualification

Use Node 22, locked dependencies and PostgreSQL 16:

```sh
pnpm test
MUDFUT_KEEP_FIXTURES=1 pnpm letta:fixtures
pnpm format:check
```

Set `MUDFUT_PG_BIN` if PostgreSQL 16 is not on `PATH`. Ordinary tests explicitly
skip PostgreSQL integration when automatic discovery is unavailable; an invalid
explicit toolchain fails. The fixture command executes the database checks and can
retain its stopped cluster with `MUDFUT_KEEP_FIXTURES=1`.

Fictional checks cover multi-claim originals, dates and withdrawals, source edits,
invalidations, scoped privacy, threads, original-source provenance, semantic grouping,
bounded/resumable review, malformed/incomplete model submissions, opt-outs, concurrent
maintenance and a read-only archive with a separate derived writer. Mock-model checks
qualify the integration contract, not general interpretation accuracy. No broad model
quality benchmark, deployment qualification or permission to activate replies is implied.
