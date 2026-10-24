# Install an independent instance

Supported host: macOS or Linux, Node 22, pnpm 11.28.7, and PostgreSQL 16. The local
runtime requires a dedicated loopback database and role named `mudfut_pilot`.
These are local installation names, not connections to any existing server.
Windows and hosted multi-user deployment are not validated in this release.

## Host availability

Run the bot and its PostgreSQL database on the same host. Fly.io and a separate
archive service are not required for this installation. Cloning the source from
GitHub does not provision hosting or start a continuously available bot.

Keep the host awake and connected to the internet, PostgreSQL available, and the
worker running for continuous replies and learning. Sleep, shutdown, loss of
connectivity, or stopping the worker interrupts service. `pnpm start` runs in the
foreground; keep that process running, or use the service options in
[OPERATIONS.md](OPERATIONS.md). A service manager can supervise the process but
does not make a sleeping host available. A continuously running Linux host is
also supported; a Mac is not required.

## 1. Install dependencies

Follow the [repository installation steps](../README.md#install) to clone the
source and install from the root lockfile. The model-free checks can run without
Discord credentials or a model login; starting the bot requires the setup below.

## 2. Create private state and PostgreSQL

Choose a new directory outside the checkout. Do not point a new installation at
another bot's state or database.

```sh
export MUDFUT_STATE_DIR="$HOME/.local/state/mudfut"
mkdir -p "$MUDFUT_STATE_DIR"
chmod 700 "$MUDFUT_STATE_DIR"
createuser --pwprompt mudfut_pilot
createdb --owner=mudfut_pilot mudfut_pilot
cp examples/pilot.json examples/postgres.json "$MUDFUT_STATE_DIR/"
chmod 600 "$MUDFUT_STATE_DIR/"*.json
```

The PostgreSQL commands use your local administrative connection and prompt for
a new database-role password. If those names already exist, inspect them instead
of overwriting or dropping anything. The role needs permission to create the
pilot's own tables and indexes in its dedicated database; it does not need to be
a PostgreSQL superuser. On installations where the public schema is not owned
by the database owner, grant this dedicated role schema access in that database.

Edit private `postgres.json` with the password you just chose. Keep host
`127.0.0.1`, database `mudfut_pilot` and user `mudfut_pilot`; adjust the loopback
port if needed. Edit `pilot.json` with your own Discord guild and reply-channel
IDs. Its channel is the live ingestion/reply scope. Optional archive access is
separate and is described in [ARCHIVE.md](ARCHIVE.md).

## 3. Create your Discord bot

Create an application and bot in the Discord Developer Portal. Enable Message
Content Intent. Install the bot in the server with View Channels, Read Message
History and Send Messages for your chosen guild text channel. Copy only your own
bot token into a private regular file named `discord-token` in the state directory
(no environment-variable syntax), then run:

```sh
chmod 600 "$MUDFUT_STATE_DIR/discord-token"
```

Do not paste tokens into issues, commit them, or put them in shell commands or
screenshots. The runtime checks the channel's guild identity before processing.
Keep any other bot runtime using this identity from replying in the same channel.

## 4. Sign in with your own account

The current runtime uses Letta's renewable ChatGPT provider login. Keep its
provider store in this installation's private state directory:

```sh
LETTA_LOCAL_BACKEND_DIR="$MUDFUT_STATE_DIR/letta"   node node_modules/@letta-ai/letta-code/letta.js --backend local connect chatgpt
```

Complete the native login flow yourself. No original maintainer token or account
is shipped. The login must provide a renewable token in this installation's Letta
provider store. Supported models and availability depend on your account and the
pinned runtime. This release has no paid API-key fallback.

The older `MUDFUT_AUTH_MODE=codex-snapshot` path exists for the opt-in fictional
model proof and copies a short-lived access-token snapshot; it is not the
unattended bot setup. Never transfer either credential store to CI or a repository.

## 5. Configure and start

Copy `.env.example` to `.env`, set the same absolute `MUDFUT_STATE_DIR`, and keep
`MUDFUT_AUTH_MODE=letta`. Select a model your own provider login supports through
`MUDFUT_MODEL`. Optional `MUDFUT_PERSONA_STYLE_FILE` names an absolute path to a
small regular UTF-8 style file; see `examples/persona-style.md`. The built-in
source and tool rules remain ahead of these style preferences.

```sh
pnpm start
```

The supervisor starts exactly one worker. Ctrl-C asks it to checkpoint and stop;
inspect any ambiguous delivery or held failure before resuming. Database schema
initialization happens only in your configured pilot database. No archive sweep
is started automatically without an explicit historical selection.

## Before inviting real conversation

Use a separate test channel and your own controlled messages first. Check that
unaddressed messages do not receive replies, addressed replies cite originals,
source changes invalidate dependent understanding, and restarts retain memory.
Ordinary checks never send a Discord message or call a model on your behalf.

To serve several text channels in the same guild, keep `channelId` as the primary
channel and add `replyChannelIds` containing every live channel, including the
primary. All channels use the same agent and memory, with independent durable
polling cursors and replies sent in their source channel. For example:

```json
{
  "guildId": "111111111111111111",
  "channelId": "222222222222222222",
  "replyChannelIds": ["222222222222222222", "222222222222222223"]
}
```

Stop the worker and verify that other runtimes have relinquished these channels
before expanding the configuration. Existing primary-channel progress is retained;
new channels start with a quiet recent-message catch-up, without replaying old
requests or commands. Requests after that initial catch-up are handled normally.
For a coordinated takeover, record private per-channel boundaries before stopping
the previous sender, drain it, then seed the new cursors from those boundaries so
requests arriving during the switch are retained. Reconcile any old sender receipts
in that interval before resuming; never blindly resend an ambiguous delivery.
Channel removal and primary/guild replacement require an explicit migration of
pending work; startup refuses to silently drop persisted reply routes.

Reply routes also accept guild announcement channels and forums. A forum route
follows its active public discussion threads, with independent thread cursors;
new discussions discovered after activation include their first post. Reopened
discussions resume their saved cursor. Activity created and archived entirely
while the worker is offline remains archive material and is not automatically
replayed as live replies. The configured forum itself is not a message endpoint.
