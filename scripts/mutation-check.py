#!/usr/bin/env python3
"""Mutation check: deliberately break each critical behaviour and assert the
suite turns RED. A mutation that survives means the test was cosmetic."""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path("/home/tony/work/claude-slack-bridge")

MUTATIONS = [
    (
        "routing: reply keyed by own ts instead of thread parent ts",
        "src/session/routing.ts",
        "const threadTs = message.thread_ts ?? message.ts;",
        "const threadTs = message.ts;",
    ),
    (
        "lock: acquire always grants (no mutual exclusion)",
        "src/session/lock.ts",
        "if (entry.locked) return Promise.resolve(false);",
        "if (false) return Promise.resolve(false);",
    ),
    (
        "formatting: convert markdown *inside* code fences too",
        "src/slack/formatting.ts",
        "parts.push(match[1] ?? \"\");",
        "parts.push(convertSpan(match[1] ?? \"\"));",
    ),
    (
        "formatting: truncate ignores the limit",
        "src/slack/formatting.ts",
        "return `${text.slice(0, limit - 3)}...`;",
        "return text;",
    ),
    (
        "formatting: splitter never closes an open fence",
        "src/slack/formatting.ts",
        "chunks.push(`${current}\\n\\`\\`\\``);",
        "chunks.push(current);",
    ),
    (
        "formatting: bold conversion dropped",
        "src/slack/formatting.ts",
        '.replace(/\\*\\*(.+?)\\*\\*/g, "*$1*")',
        ".replace(/\\*\\*(.+?)\\*\\*/g, " + json.dumps("**$1**") + ")",
    ),
    (
        "protocol: tool_result error flag ignored",
        "src/claude/protocol.ts",
        "isError: bool(rec.is_error) ?? false,",
        "isError: false,",
    ),
    (
        "protocol: result error flag ignored",
        "src/claude/protocol.ts",
        'isError: bool(message.is_error) ?? str(message.subtype) !== "success",',
        "isError: false,",
    ),
    (
        "protocol: init accepts an empty session id",
        "src/claude/protocol.ts",
        '      const sessionId = str(message.session_id);\n      if (sessionId === undefined) return [];\n      return [\n        {\n          type: "init",',
        '      const sessionId = str(message.session_id) ?? "";\n      return [\n        {\n          type: "init",',
    ),
    (
        "protocol: result accepts an empty session id",
        "src/claude/protocol.ts",
        '      const sessionId = str(message.session_id);\n      if (sessionId === undefined) return [];\n      return [\n        {\n          type: "result",',
        '      const sessionId = str(message.session_id) ?? "";\n      return [\n        {\n          type: "result",',
    ),
    (
        "protocol: parallel tool_use keeps only the first block",
        "src/claude/protocol.ts",
        '      case "tool_use": {\n        events.push({',
        '      case "tool_use": {\n        if (events.length > 0) break;\n        events.push({',
    ),
    (
        "session: send() does not push the user turn into the prompt",
        "src/claude/session.ts",
        '    if (!this.running) throw new Error("ClaudeSession not started");\n    this.input.push({',
        '    if (!this.running) throw new Error("ClaudeSession not started");\n    if (false) this.input.push({',
    ),
    (
        "renderer: a final block is appended instead of replacing its deltas",
        "src/slack/renderer.ts",
        "          // The authoritative block supersedes any deltas that streamed it.\n          this.live = undefined;\n          this.push(event.text);",
        "          this.push(event.text);",
    ),
    (
        "renderer: a delta overwrites the live buffer instead of extending it",
        "src/slack/renderer.ts",
        '          this.live = (this.live ?? "") + event.text;',
        "          this.live = event.text;",
    ),
    (
        "renderer: tool calls are not counted",
        "src/slack/renderer.ts",
        "        this.tools += 1;",
        "        this.tools += 0;",
    ),
    (
        "renderer: an errored result is reported as success",
        "src/slack/renderer.ts",
        "        if (event.isError) {\n          this.errored = true;",
        "        if (false) {\n          this.errored = true;",
    ),
    (
        "manager: a conversation gets a brand-new session every message",
        "src/session/manager.ts",
        "    if (existing !== undefined) {\n      existing.lastActivity = this.now();\n      return existing.session;\n    }",
        "    if (false) {\n      existing!.lastActivity = this.now();\n      return existing!.session;\n    }",
    ),
    (
        "manager: eviction ignores whether a session is busy",
        "src/session/manager.ts",
        '.filter((record) => record.status === "idle")',
        ".filter(() => true)",
    ),
    (
        "manager: remove() leaks the session instead of closing it",
        "src/session/manager.ts",
        "    record.session.close();\n    this.records.delete(key);",
        "    this.records.delete(key);",
    ),
    (
        "bridge: the authorization gate is skipped",
        "src/bridge/index.ts",
        "    if (!this.deps.auth.isAuthorized(message.user)) {",
        "    if (false) {",
    ),
    (
        "bridge: anyone may press an approval button",
        "src/bridge/index.ts",
        "    if (!this.deps.auth.isAuthorized(action.userId)) {",
        "    if (false) {",
    ),
    (
        "bridge: a busy conversation accepts a competing turn",
        "src/bridge/index.ts",
        "    const acquired = await this.locks.acquire(ctx.key);\n    if (!acquired) {",
        "    const acquired = await this.locks.acquire(ctx.key);\n    if (false) {",
    ),
    (
        "bridge: the conversation lock is never released",
        "src/bridge/index.ts",
        "      this.sessions.markIdle(ctx.key);\n      this.locks.release(ctx.key);",
        "      this.sessions.markIdle(ctx.key);",
    ),
    (
        "bridge: streamed edits ignore the throttle",
        "src/bridge/index.ts",
        "    if (!force && this.now() - handle.lastEditAt < this.editIntervalMs) return;",
        "    if (false) return;",
    ),
    (
        "bridge: the turn's final update is skipped inside the throttle window",
        "src/bridge/index.ts",
        "      await this.deps.slack.updateMessage({  channel: handle.channel, ts: handle.slackTs, text });",
        "      if (this.now() - handle.lastEditAt >= this.editIntervalMs) {\n        await this.deps.slack.updateMessage({  channel: handle.channel, ts: handle.slackTs, text });\n      }",
    ),
    (
        "bridge: deny is treated as allow",
        "src/bridge/index.ts",
        '    const decision: ApprovalDecision =\n      kind === "deny" ? { kind: "deny" } : { kind: "allow" };',
        "    const decision: ApprovalDecision = { kind: \"allow\" };",
    ),
    (
        "commands: an absolute path is mistaken for a command",
        "src/bridge/commands.ts",
        "  if (!/^\\/[A-Za-z]+$/.test(token)) return null;",
        "  if (false) return null;",
    ),
    (
        "formatting: the splitter never breaks a long message",
        "src/slack/formatting.ts",
        "  if (text.length <= limit) return [text];",
        "  return [text];",
    ),
]


def run_tests() -> tuple[bool, str]:
    proc = subprocess.run(
        ["npx", "vitest", "run", "--reporter", "basic"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    out = proc.stdout + proc.stderr
    failed = "Test Files" in out and re.search(r"(\d+) failed", out)
    tail = "\n".join(
        [l for l in out.splitlines() if re.search(r"Tests\s+\d|Test Files\s+\d", l)]
    )
    return (proc.returncode == 0 and not failed), tail


def main() -> int:
    survivors: list[str] = []
    killed: list[str] = []
    for name, rel, old, new in MUTATIONS:
        path = ROOT / rel
        original = path.read_text()
        if old not in original:
            print(f"[SKIP/ANCHOR-MISS] {name}")
            survivors.append(f"{name} (anchor not found — mutation not applied)")
            continue
        backup = path.with_suffix(path.suffix + ".bak")
        shutil.copy2(path, backup)
        try:
            path.write_text(original.replace(old, new, 1))
            passed, tail = run_tests()
            status = "KILLED (good)" if not passed else "SURVIVED (bad)"
            print(f"[{status}] {name}")
            print(f"           {tail}")
            (killed if not passed else survivors).append(name)
        finally:
            shutil.copy2(backup, path)
            backup.unlink()
    # restore-and-verify
    passed, tail = run_tests()
    print("\n=== after restoring all mutations ===")
    print(f"baseline green: {passed}  {tail}")
    print(f"\nkilled={len(killed)}  survived={len(survivors)}")
    for s in survivors:
        print(f"  SURVIVOR: {s}")
    return 0 if not survivors and passed else 1


if __name__ == "__main__":
    sys.exit(main())
