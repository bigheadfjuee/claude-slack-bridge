# Architecture

## Why a daemon, and not an extension

`pi-slack-bridge` is a **pi extension**: `pi` exposes a plugin API, so the
bridge loads *into* the agent's own process and speaks to Slack directly.

Claude Code offers no such hook. It cannot be extended from outside, so the
only two ways to drive it are:

1. the CLI in print mode — `claude -p --input-format stream-json
   --output-format stream-json`;
2. the official **Claude Agent SDK**.

Both stream multi-turn conversations from a single process, and both honour
`--resume`. They diverge on one decisive point: **tool-use approval**. In print
mode Claude reports *"this session has no approval surface"* and
`--permission-prompts host|none` has no effect — there is no channel over which
a permission request can be answered. The SDK, by contrast, exposes a
`canUseTool` callback that the host can resolve asynchronously.

Since *"approve the Bash command Claude wants to run, from Slack"* is the whole
point of a remote control surface, the Agent SDK is the only viable substrate.
That in turn means the bridge has to be a **standalone long-running daemon**
rather than a plugin.

```
Slack  ⇄  claude-slack-bridge (this daemon)  ⇄  Claude Agent SDK  ⇄  Claude Code
 │                     │
 │  Socket Mode        │  canUseTool → approval card → button click → resolve
 └─────────────────────┘
```

## Data flow of one message

```
Slack message
   │
   ▼
Bridge.handleMessage ──► auth.isAuthorized? ──no──► "not authorised" ephemeral
   │ yes
   ▼
parseCommand? ──yes──► handleCommand (/stop, /new, /status, …)
   │ no
   ▼
routing.conversationKey  →  "<channel>/<thread_ts>"
   │
   ▼
lock.acquire(key)  ──held──► "already working" ephemeral
   │ free
   ▼
sessions.markWorking(key)  +  post placeholder  ← user sees Claude picked it up
   │
   ▼
ClaudeSession.send(prompt) ──► Agent SDK ──► assistant deltas
   │                                             │
   │   (throttled edit of the placeholder)  ◄────┘
   │
   │   tool_use ──► canUseTool ──► approvals.register
   │                                   │
   │                            Slack card with buttons
   │                                   │
   │                            button click → approvals.decide → resolve
   ▼
result ──► final edit  +  lock.release  +  manager.markIdle
```

## Module map

| Module | Responsibility |
|---|---|
| `types/index.ts` | The shared vocabulary: `SessionEvent`, `BridgeConfig`, `PermissionMode`, `ConversationKey`. |
| `config/index.ts` | Precedence env > file > default; allowlists unioned; workdir `~` expansion. |
| `auth/authenticator.ts` | Allowlist + challenge-code handshake. |
| `auth/store.ts` | Persists authorisations to JSON so restarts do not re-lock users. |
| `session/routing.ts` | Turns a Slack message into a conversation key (`<channel>/<thread>`). |
| `session/lock.ts` | Per-conversation mutual exclusion — one turn at a time per thread. |
| `session/manager.ts` | Session registry with an LRU cap that **never evicts a busy session**. |
| `session/approvals.ts` | Pending tool-call approvals, decided by id, cancelled on shutdown. |
| `claude/protocol.ts` | Parses raw SDK messages into `SessionEvent`s. |
| `claude/session.ts` | `ClaudeSession`: lifecycle, send, interrupt, resume, permissions. |
| `claude/query.ts` | The single place the Agent SDK is imported; maps options and wraps `query()`. |
| `slack/formatting.ts` | Markdown → Slack `mrkdwn`; long-message splitting and truncation. |
| `slack/renderer.ts` | `TurnTranscript`: folds deltas, commits blocks, counts tools, tracks errors. |
| `slack/blocks.ts` | Block Kit builders: approval card, resolved card, session list, help. |
| `slack/client.ts` | The whole Slack contract — four WebClient calls behind one seam. |
| `bridge/commands.ts` | Parses `/command` messages, narrowly, so paths are not swallowed. |
| `bridge/index.ts` | The orchestrator: auth gate, routing, turn lifecycle, throttled edits. |
| `index.ts` | Entrypoint: Bolt app, Socket Mode, the real `queryFn`, signal handling. |

## Three decisions worth knowing

### 1. Deltas stream, then repeat — so the final block *replaces*, not appends

With partial messages enabled, the SDK first streams a sentence as
`stream_event` deltas and then delivers the same text again as one authoritative
`assistant` block. A naive renderer appends both and the answer arrives
doubled. `TurnTranscript` therefore keeps a *live* buffer for uncommitted
deltas and, when a final block for that text arrives, drops the live buffer and
commits the block once.

### 2. One Slack message, edited in place, throttled

A turn produces one Slack message. It is edited as tokens arrive, but the edit
is skipped unless a minimum interval has elapsed — except for the very last
update of a turn, which is always forced, so the final text is never the one
that happened to fall inside a throttle window.

### 3. Approval is as privileged as prompting

Anyone able to press **Allow** can wave a dangerous command through, so
`handleAction` runs the same authorisation check as `handleMessage`. An
unauthorised click gets an ephemeral "not authorised" and changes nothing.

## Testing

The project is test-first: each module's test was written to fail before the
module existed, and the failure was observed. `scripts/mutation-check.py` then
deliberately corrupts the highest-risk behaviour — the auth gates, the lock,
the throttle, the dedup rule, deny-vs-allow — and asserts the suite turns red,
proving the tests are load-bearing rather than decorative. The SDK is injected
behind small interfaces (`QueryLike`, `SlackLike`), so the entire suite runs
with no network and no live agent.
