# claude-slack-bridge

**Bridge Slack into Claude Code** — a pure Slack remote control surface for the
[Claude Code](https://claude.com/claude-code) coding agent.

Drive Claude Code from a Slack channel or DM: send a prompt, watch it answer
token by token, approve or deny the tools it wants to run, interrupt it
mid-turn, and keep a separate long-lived conversation per Slack thread.

It is a deliberately small, single-binary daemon — no web dashboard, no
database, no queue. Slack *is* the interface.

---

## Why this exists

[`pi-slack-bridge`](https://github.com/bigheadfjuee/pi-slack-bridge) does the
same thing for the `pi` coding agent, by loading itself as a **pi extension**.
Claude Code has no equivalent extension API — it cannot be hooked from
outside, and its `claude -p --output-format stream-json` mode, while it streams
fine, exposes **no approval surface**: in print mode Claude reports
*"this session has no approval surface"*, and the `--permission-prompts` flag
has no effect.

So this project takes the other road: it is a **standalone daemon** built on
the official **[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)**.
The SDK is the only supported path that surfaces a `canUseTool` callback, which
is what makes *"approve this Bash command from Slack"* possible at all. The
architecture is documented in [`docs/architecture.md`](docs/architecture.md).

---

## Features

- **Thread-scoped sessions** — each Slack thread is its own conversation with
  its own Claude session. A top-level message opens one; replies continue it.
- **Streaming replies** — the answer is posted once and edited in place as
  tokens arrive, throttled to stay inside Slack's rate limits.
- **Tool-call approval in Slack** — when Claude wants to run a tool, a card
  appears with **Allow**, **Allow always**, and **Deny** buttons; the decision
  is fed straight back into the agent. Only authorised users may press them.
- **Interrupt** — `/stop` cancels the turn Claude is running.
- **Session reuse** — conversations persist; `/new` starts fresh, `/resume`
  rebinds a thread to an existing session.
- **Access control** — a user allowlist plus a one-time challenge-code
  handshake, persisted to disk so it survives restarts.
- **No secrets in the repo** — tokens come from the environment or a
  `~/.claude-slack-bridge/config.json` you control.

---

## Quick start

### 1. Create a Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. **Socket Mode** → enable it, and create an app-level token with the
   `connections:write` scope. That is your `CLAUDE_SLACK_APP_TOKEN` (`xapp-…`).
3. **OAuth & Permissions** → Bot Token Scopes, add:
   `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`,
   `channels:history`, `groups:history`, `reactions:write`, `users:read`.
4. **Event Subscriptions** → subscribe to bot events: `app_mention`,
   `message.im`.
5. **Interactivity & Shortcuts** → enable it (this is what delivers the
   approval button clicks).
6. **Install App** to your workspace and copy the **Bot User OAuth Token**
   (`xoxb-…`). That is your `CLAUDE_SLACK_BOT_TOKEN`.

### 2. Configure

```bash
git clone https://github.com/bigheadfjuee/claude-slack-bridge.git
cd claude-slack-bridge
npm install
cp .env.example .env      # then edit .env
```

At minimum set:

```dotenv
CLAUDE_SLACK_BOT_TOKEN=xoxb-…
CLAUDE_SLACK_APP_TOKEN=xapp-…
CLAUDE_SLACK_ALLOWED_USERS=U012ABCDEF   # your Slack user id (see /whoami)
```

Everything else is optional — see [Configuration](#configuration).

### 3. Make sure Claude Code is logged in

The daemon runs Claude through the Agent SDK, which uses your existing Claude
Code credentials. Confirm `claude` is installed and logged in on the machine
that will run the bridge:

```bash
claude --version
```

### 4. Run it

```bash
npm run build && npm start
# or, for a quick spin without a build step:
npm run dev
```

Then message the bot in Slack (mention it in a channel, or DM it).

---

## Commands

| Command | What it does |
|---|---|
| `/help` | Show the command list |
| `/status` | This thread's session id, model, permission mode, and directory |
| `/new` | Start a fresh Claude session in this thread |
| `/stop` | Interrupt the turn Claude is currently running |
| `/sessions` | List recent Claude sessions on this machine |
| `/resume <id>` | Rebind this thread to an existing session |
| `/model <name>` | Switch model (`opus`, `sonnet`, `haiku`, or a full name) |
| `/mode <mode>` | Set the permission mode (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`) |
| `/cwd <path>` | Change the working directory (starts a fresh session) |
| `/whoami` | Your Slack id and whether you are authorised |

Anything that is not a command is sent to Claude as a prompt. A message that
merely *looks* like a command — a bare path such as `/usr/local/bin` — is
treated as chat.

---

## Configuration

Values are read from the environment first, then from
`~/.claude-slack-bridge/config.json`, then from built-in defaults. Allowlists
from both sources are **unioned**, so adding a colleague to the file never
drops one you exported in your shell.

| Environment variable | Config file key | Purpose |
|---|---|---|
| `CLAUDE_SLACK_BOT_TOKEN` | `slack.botToken` | Bot token (`xoxb-…`). Required. |
| `CLAUDE_SLACK_APP_TOKEN` | `slack.appToken` | App-level token (`xapp-…`). Required for Socket Mode. |
| `CLAUDE_SLACK_ALLOWED_USERS` | `allowedUsers` | Comma-separated Slack user ids that skip the handshake. |
| `CLAUDE_SLACK_CHALLENGE_CODE` | `challengeCode` | One-time code a new user sends to prove identity. |
| `CLAUDE_SLACK_WORKDIR` | `workdir` | Default working directory for new sessions. |
| `CLAUDE_SLACK_MODEL` | `model` | Model alias or full name. |
| `CLAUDE_SLACK_PERMISSION_MODE` | `permissionMode` | Default permission mode. |

### Authorisation

A user is authorised if they are on the allowlist or have completed the
challenge handshake. Both live in `~/.claude-slack-bridge/auth.json`
(allowlist entries from the environment are checked in addition). Pressing an
approval button is treated as privileged and requires the same authorisation as
sending a prompt.

> **Note on `bypassPermissions`:** setting it makes Claude run tools without
> asking. That is occasionally useful, and deliberately not the default.

---

## Security

- The daemon executes whatever Claude decides to run in your working directory.
  Treat access to the bot as equivalent to shell access on that machine, and
  keep the allowlist tight.
- Tokens are never written to the repo; `.env` is gitignored and the config file
  is created with `0600` permissions.
- Approval buttons are gated on authorisation, so someone who can see the
  channel cannot wave through a command they are not entitled to approve.

---

## Development

```bash
npm test          # vitest, single run
npm run test:watch
npm run lint      # biome
npm run typecheck # tsc --noEmit
```

The project is built test-first: every module has a test that was written to
fail before the code existed. The critical logic is additionally covered by a
mutation check that deliberately corrupts behaviour and asserts the tests
notice:

```bash
python3 scripts/mutation-check.py
```

See [`docs/architecture.md`](docs/architecture.md) for the module map and the
design decisions behind them.

---

## Licence

MIT — see [LICENSE](LICENSE).
