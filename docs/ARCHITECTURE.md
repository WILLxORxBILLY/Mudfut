# Architecture

The public release contains the current Letta bot.
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

Private configuration and runtime state live outside the checkout. The archive
is optional and has a separate reader role. Ordinary checks use fictional data;
production deployments, credentials and real evidence are not release inputs. There are no migrations from a maintainer's private server.

## A fictional walkthrough

The [PostgreSQL knowledge fixture](../experiments/letta/community-knowledge.test.mjs)
models a small, fictional discussion. A speaker says, “I will take the train for
this trip.” A candidate attributes a preference for the train to that speaker.
The candidate is an interpretation of the statement, not proof of the speaker’s
broader beliefs.

Before that candidate is committed, the source is edited to add “unless the
weather turns.” The old pending work is rejected as stale. The fixture then
supplies a new candidate qualified by the weather, commits it, and confirms that
a replay does not create a duplicate. Opening a correction withdraws the
dependent candidate from the profile view and retains a correction receipt and
invalidated annotation; a previously prepared export cannot commit after the
source is removed. The system does not automatically establish what the speaker
really believes or resolve the interpretation.

Run `pnpm letta:fixtures` to execute this case in disposable PostgreSQL. Look for
“PostgreSQL knowledge jobs survive replacement, reject stale source work, and
block delayed exports.” The candidate is supplied by the fixture, not produced or
evaluated by a model; this is an integrity and recovery check, not a measure of
model reasoning quality.

## Inspect the guarantees

The following checks use fictional inputs and run without Discord or a model.
Tests marked for PostgreSQL need the disposable fixture runner; `pnpm test` alone
skips those database cases. Run `pnpm letta:fixtures` as described in the
[README](../README.md#checks-without-model-credentials).

| Question                                              | Implementation and executable evidence                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What ties a claim to its sources?                     | [Memory validation](../experiments/letta/pilot-memory.mjs) checks evidence and lineage; [memory PostgreSQL tests](../experiments/letta/memory-postgres.test.mjs) exercise revisions, corrections and invalidation.                                |
| What happens when a source or interpretation changes? | [Knowledge tests](../experiments/letta/community-knowledge.test.mjs) exercise stale work, correction withdrawal and revisioned views; [recovery tests](../experiments/letta/community-knowledge-review.test.mjs) fence edited or deleted sources. |
| What if a model omits an observation decision?        | [Generation failure tests](../experiments/letta/generation-failures.test.mjs) verify retry, a persistent hold and continued processing of other work.                                                                                             |
| What happens around interrupted work or delivery?     | [Recovery tests](../experiments/letta/recovery-check.test.mjs) and [reliability tests](../experiments/letta/reliability.test.mjs) exercise durable state and ambiguous-delivery handling.                                                         |

For a small credential-free example after installing dependencies, run:

```sh
node --test --test-name-pattern="only incomplete live model output" experiments/letta/generation-failures.test.mjs
```

The fictional case checks that only an incomplete live observation decision is
eligible for deferral; database, delivery and historical failures are not
reclassified as that error. The separate PostgreSQL case in the same file checks
the durable retry and hold behavior through `pnpm letta:fixtures`.

These checks establish behavior for the tested cases, not whether the model
chooses a useful interpretation, correctly understands disagreement, or produces
a good reply. Semantic review needs independent, unused cases and human judgment;
the optional private-input tests are skipped without their inputs. No public
model-quality benchmark is included.
