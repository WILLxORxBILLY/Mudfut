# Contributing

Start with the model-free checks. Open an
issue describing the behavior and a synthetic reproduction before a large change.
Do not submit conversation exports, real member IDs, credentials, production
configuration or private model/evaluation results. Screenshots must use fictional data.

Use Node 22 and the root lockfile. Run `pnpm test`, `pnpm letta:fixtures` with
PostgreSQL 16 binaries, and `pnpm format:check`. Preserve dependency patches and
keep tests model-free. A semantic behavior change needs unused evaluation cases;
a systems fixture pass does not establish general answer quality.

Keep evidence separate from interpretations and generated prose. Source revisions,
context roles, exact quotations, currentness, correction lineage and ambiguous
sending are part of the public interface. Use stable keys for the same claim and
retain distinct qualified claims. Do not add another memory authority or perform
an unbounded corpus sweep to make a demonstration look complete.
