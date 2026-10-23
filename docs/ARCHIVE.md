# Optional historical archive

The live bot can run without an archive. Historical search and review can also
read an existing PostgreSQL archive through a separate
loopback role named `mudfut_history_reader`. This is an integration contract, not
a full-server crawler or a claim that every Discord message has been captured.

The expected `messages` table shape is in [archive-schema.sql](archive-schema.sql).
It contains source identity, text, timestamps, edit/deletion state and reply
references. Use your own authorized Discord exporter/ingestion process to populate
it and retain the original identities and mutation state. Never load generated
summaries as original messages. Thread and attachment completeness remain separate
coverage questions. The sample schema does not grant any roles automatically.

Give the dedicated reader SELECT access only, set its default transactions to
read-only, and store its configuration in private `history-postgres.json` beside
the pilot configuration. The sample file in `examples/` has placeholders only.
Keep host `127.0.0.1` and user `mudfut_history_reader`; choose your own archive
database and password. No database contents are supplied with this project.

Historical model work uses selected manifests and exact current Discord validation;
selection, context exposure, committed review and representation are different
stages. Archive availability alone does not establish complete Discord coverage.

A restored snapshot has no automatic refresh. Before admitting another review
batch, reconcile it with your ingestion source, retaining edits, tombstones,
reply references and timestamp precision. Record the source snapshot time and
compare message identities and mutation state; a recent message date or matching
row count alone does not prove that older edits and deletions are synchronized.

Historical threads use their own Discord channel ID, including archived public
threads. The reader accepts legacy NULL thread tags and canonical
`thread_id=channel_id` tags, validates the current guild and thread parent, and
refreshes originals before learning. Historical review does not add a thread to
the live reply routes. Completed read receipts remain committed even if their
episode later enters a deferred state; a new range skips those reviewed targets.

Stage a bounded, immutable selection with `pnpm history stage /absolute/private/selection.json`
or a knowledge manifest with `pnpm knowledge stage /absolute/private/manifest.json`.
Inspect the JSON examples and CLI validators before selecting real data. These
commands operate on your installation; do not reuse another installation's IDs.
No model or Discord sender is invoked by staging alone. The existing worker owns
subsequent historical generation, with live replies taking priority.
