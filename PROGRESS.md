# Build progress (resume here)

## Status: feature-complete, verified locally; pending first push

### Done

- **Research + feasibility proved.** Reverse-engineered `pi-slack-bridge` and
  probed both ways of driving Claude. Decisive finding: the CLI's print mode has
  **no approval surface**; the Agent SDK's `canUseTool` is the only path to
  Slack-side tool approvals. Written up in `/home/tony/work/RESEARCH-claude-slack-bridge.md`
  and `docs/architecture.md`.
- **All modules implemented and tested.** 17 source modules, 16 test files,
  **221 tests green**, `tsc --noEmit` clean, `biome check` clean.
- **Mutation check: 28 mutations, 28 killed, 0 survived.** Baseline re-verified
  green after restore. (`scripts/mutation-check.py`, logs `mutation-r1..r4.log`.)
  - r3 exposed one *weak test* — "always performs the final update…" passed even
    with `finalise` broken, because it emitted its last text as a non-delta
    block the `text` handler already force-flushed. Rewritten to end on a
    throttled delta; r4 then killed that mutation.
- **Entrypoint** `src/index.ts` (Bolt + Socket Mode) builds and fails cleanly
  when Slack credentials are absent.
- **Docs**: `README.md`, `docs/architecture.md`, `LICENSE`, `.env.example`.

### Pending

1. Live end-to-end (`scripts/e2e.mjs`) — real SDK + real Claude + fake Slack,
   driving a Bash approval round-trip. Running.
2. `git init` + first commit + push to `bigheadfjuee/claude-slack-bridge` (public).

### Notes for whoever resumes

- The mutation runner edits `src/` in place. **Never read, trust or edit source
  while it runs** — a mutant looks like real code. Wait for `survived=0` and
  `baseline green: True`.
- `gh` is not installed; push over SSH (`git@github.com:…`), which authenticates
  as `bigheadfjuee3`.
- SDK is confined to `src/claude/query.ts`; everything else depends on the tiny
  `QueryLike` interface, so tests need no agent and no network.
