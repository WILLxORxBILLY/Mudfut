# Third-party notices

The project uses separately licensed dependencies, including Letta Agent SDK,
Letta Code and discord.js (Apache-2.0), PostgreSQL's `pg` client (MIT), and their
transitive dependencies. The project's MIT source license does not replace
those terms or grant access to a provider account, Discord service, model or
third-party trademark.

The patch under `patches/` modifies portions of the Apache-2.0 Letta Code package
to disable unused bundled MCP OAuth entry points. It does not relicense that code.
Preserve upstream copyright/license notices when distributing that dependency.
Original dependency license files are installed with their packages. An inventory
of the release's installed dependency licenses is provided in
`docs/dependency-licenses.json`.
