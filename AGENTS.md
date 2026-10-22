# Contributor instructions

Keep the runtime and graph small, source-backed and portable. PostgreSQL owns
messages, work, memory revisions and annotations; the graph is a derived read view.
Never treat model output or correction notes as independent original evidence.
Preserve exact quotations, attribution, source changes, correction lineage and
ambiguous-delivery holds. Keep live replies ahead of historical generation and
retain one writer per installation.

Runtime state, tokens, databases, source exports and real community evaluations
belong outside this repository. Commit fictional fixtures only. Do not make
network/model calls or send Discord messages in ordinary checks. Use the disposable
PostgreSQL runner; never test schema-writing factories against an operator's state.

Use Node 22 and the pinned pnpm version. Run `pnpm test`, `pnpm letta:fixtures`
(with PostgreSQL 16 binaries), and `pnpm format:check` for relevant changes. Keep
one meaningful runnable check for nontrivial logic. No framework is needed for a
small check. Mark deliberate shortcuts with a `ponytail:` comment that names the
ceiling and upgrade path. Preserve dependency patches unless a tested upstream
upgrade replaces their protections.
