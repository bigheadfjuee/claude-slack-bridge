# Changelog

All notable changes to this project are documented here.

## [0.1.0] — unreleased

Initial implementation.

### Added

- **Session hand-over between Slack and the CLI** — `/sessions` lists every
  saved Claude session on the machine (via the SDK's `listSessions`);
  `/resume <id|prefix> [--fork]` continues one in its original directory, or
  forks it; `/handoff` releases a thread's session and prints the
  `claude --resume` command.
- **Persistent thread bindings** — `~/.claude-slack-bridge/threads.json` maps
  each thread to its Claude session, so threads resume after a restart or a
  CLI hand-off.
- **Slack remote control** for the Claude Code agent, as a standalone daemon on
  the official Claude Agent SDK.
- **Thread-scoped sessions** — one long-lived Claude session per Slack thread;
  top-level messages open a conversation, replies continue it.
- **Streaming replies** — a turn posts one message and edits it in place as
  tokens arrive, throttled to respect Slack's rate limits, with the final update
  always forced.
- **Tool-call approval in Slack** — `canUseTool` is surfaced as a Block Kit card
  with Allow / Always allow / Deny buttons; the decision is fed back to the agent.
  Approving is gated on the same authorisation as prompting.
- **Commands** — `/help`, `/status`, `/new`, `/stop`, `/sessions`, `/resume`,
  `/model`, `/mode`, `/cwd`, `/whoami`.
- **Access control** — environment/file allowlist plus a one-time challenge-code
  handshake, persisted to disk so restarts do not re-lock authorised users.
- **Configuration** — environment variables, a `~/.claude-slack-bridge/config.json`
  file, and built-in defaults, with allowlists unioned across sources.

### Verification

- 221 tests across 16 files, plus a mutation check that corrupts 28 high-risk
  behaviours and asserts the suite catches every one (28 killed, 0 survived).
