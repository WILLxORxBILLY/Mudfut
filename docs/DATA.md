# Data and operating boundaries

Each installation owns its Discord credentials, model login, private state and
PostgreSQL databases. The repository ships code and fictional fixtures only.
Keep state outside the checkout and restrict its directory to mode 0700 and
configuration/token files to mode 0600. Logs, memory, evaluation packets and graph
exports can contain conversation text and belong in that private state boundary.

The bot observes the configured live text channel and learns without replying
unless addressed. This build does not implement a working per-member opt-out
command. The operator chooses an appropriate server/channel and explains that
policy before enabling the bot. Original source edits/deletions, attribution,
exact quotations and currentness checks remain required.

Model-backed operations send selected messages, context and memory to the
configured provider through the operator's own account. The graph demo and
ordinary synthetic fixture tests make no model call. Optional model proofs and
private evaluations are explicit separate commands; they can retain source text,
model replies and tool traces outside Git. Account/model access is not bundled
with the source license and is not guaranteed by this project.

Memory and interpretation histories are append-only. The runtime retains prior
versions and correction receipts rather than silently erasing the audit trail.
Deletion invalidates dependent active knowledge; it does not promise physical
erasure of every historical audit version or backup. Establish your own retention
and backup policy before processing a community. Do not assume a lifetime memory
cap or automatic audit expiry that this runtime does not implement.

The graph is a local read-only view. It exposes private selected source text to
the local browser, uses same-origin loopback HTTP, and has no hosted authentication
layer. Do not put it behind a public reverse proxy without a separate access and
deployment design. Graph availability is not fresh Discord source validation.
Candidate interpretations remain attributed, qualified and revisable.
