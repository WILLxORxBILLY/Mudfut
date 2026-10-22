# Mudfüt

A self-hosted Discord community bot with source-backed memory. It learns from a
configured channel, replies when addressed, and keeps dated, revisable
understanding grounded in original messages.

This is an early release of the current Letta runtime. It contains no community
history, learned memories, credentials or operator configuration. The older
production gateway and its deployment machinery are outside this release.

## Install

Use Node 22, pnpm 11.28.2 and PostgreSQL 16. Clone the repository and install the
locked dependencies:

```sh
git clone https://github.com/canonicledaddy/Mudfut.git
cd Mudfut
corepack enable
pnpm install --frozen-lockfile
```

## Run your own bot

Follow [the installation guide](docs/INSTALL.md) to create your own Discord app,
dedicated local PostgreSQL database, private state directory and renewable Letta
login. Then use `pnpm start`. Your installation starts with its own empty state;
no original server, messages, channel IDs, memory or access is shared.

The default personality is named Mudfüt. An optional operator style file can
change the name and voice while retaining the source/tool/evidence instructions.
The model is configurable within the existing subscription provider. Availability
and subscription access depend on your account; there is no automatic paid API
fallback. Authentication is required only for model-backed bot operations, not
for fixture tests.

## What is included

- Addressed replies, quiet ambient learning and exact original-source retrieval.
- Individually sourced memory, dated revisions, corrections and retained history.
- Bounded historical review over an optional compatible PostgreSQL archive.
- Candidate annotations and cited profile, topic and history commands.
- Durable work, interrupted-send reconciliation, a single-writer lock and bounded
  supervisor recovery.

## Checks without model credentials

```sh
pnpm test
# Install PostgreSQL 16 server binaries first; run as a regular user, not root.
MUDFUT_PG_BIN=/path/to/postgresql-16/bin pnpm letta:fixtures
pnpm format:check
```

The fixture runner starts a fresh loopback database with random credentials and
removes only that run's cluster. Private-input checks explicitly skip when their
private files are absent. `pnpm letta:live` is a separate opt-in fictional model
proof; it uses your account and retains its results outside the repository.

## Limits

The bot currently replies in one configured guild text channel per installation.
Historical review is bounded, and archive availability does not prove complete
Discord coverage. An optional existing archive can be
connected using [the archive contract](docs/ARCHIVE.md); a full-server archive
crawler is not included in this first release. Attachments are not interpreted.

This build observes the configured channel and has no working per-member opt-out
command. Choose an appropriate channel and explain your installation's data use
to its members. See [data handling](docs/DATA.md) for what is retained and sent to
the model. The project is beta software; test a separate installation before
using it with a community.

Read the [operations guide](docs/OPERATIONS.md), [contributing guide](CONTRIBUTING.md),
and [dependency notices](THIRD_PARTY_NOTICES.md).

## License

Mudfüt is available under the [MIT License](LICENSE). You can use, modify and
redistribute it, including commercially, while retaining the license notice.
No private repository history or community database is part of this release.
