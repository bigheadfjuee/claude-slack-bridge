/**
 * End-to-end verification against a *live* Claude agent.
 *
 * Everything is real except Slack: the real Agent SDK runs a real Claude, the
 * real parser, session, renderer and bridge do their jobs, and a recording fake
 * stands in for the Slack WebClient (which would need workspace credentials we
 * deliberately do not handle). The script drives two turns in one thread and,
 * crucially, answers a live tool-permission request by "pressing the button" —
 * proving the approval round-trip actually gates a real command.
 *
 * Run with:  node scripts/e2e.mjs
 * Exits 0 on success, 1 on any failed assertion.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Authenticator } from "../dist/auth/authenticator.js";
import { Bridge } from "../dist/bridge/index.js";
import { ClaudeSession } from "../dist/claude/session.js";
import { createQueryFactory } from "../dist/claude/query.js";
import { ApprovalRegistry } from "../dist/session/approvals.js";
import { SessionLock } from "../dist/session/lock.js";

const WORKDIR = join(tmpdir(), "csb-e2e");
const FILE = join(WORKDIR, "hello.txt");
const WORD = "PONG";
const CHANNEL = "C_E2E";
const USER = "U_E2E";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** A recording stand-in for the Slack WebClient. */
function makeFakeSlack() {
  const calls = [];
  let counter = 0;
  return {
    calls,
    async postMessage(a) {
      counter += 1;
      calls.push({ op: "post", ...a, ts: `ts_${counter}` });
      return `ts_${counter}`;
    },
    async updateMessage(a) {
      calls.push({ op: "update", ...a });
    },
    async postEphemeral(a) {
      calls.push({ op: "ephemeral", ...a });
    },
  };
}

/** Find the newest approval card in the transcript and return its button id. */
function pendingApprovalId(slack, seen) {
  for (const call of slack.calls) {
    if (call.op !== "post" || !Array.isArray(call.blocks)) continue;
    for (const block of call.blocks) {
      if (block?.type !== "actions") continue;
      const id = block.elements?.[0]?.value;
      if (typeof id === "string" && !seen.has(id)) {
        seen.add(id);
        return id;
      }
    }
  }
  return undefined;
}

/** Final text of the last message the bridge posted or edited. */
function lastRenderedText(slack) {
  for (let i = slack.calls.length - 1; i >= 0; i -= 1) {
    const call = slack.calls[i];
    if (call.op === "post" || call.op === "update") return call.text ?? "";
  }
  return "";
}

async function main() {
  rmSync(WORKDIR, { recursive: true, force: true });
  mkdirSync(WORKDIR, { recursive: true });

  const slack = makeFakeSlack();
  const auth = new Authenticator({ allowlist: [USER] });
  const queryFn = createQueryFactory();

  const bridge = new Bridge({
    slack,
    auth,
    approvals: new ApprovalRegistry(),
    locks: new SessionLock(),
    createSession: (_key, spec, permissions) => {
      const session = new ClaudeSession(
        {
          cwd: spec.cwd,
          model: spec.model,
          permissionMode: spec.permissionMode,
          resume: spec.resume,
        },
        { queryFn, permissions },
      );
      session.start();
      return session;
    },
    workdir: WORKDIR,
    model: "sonnet",
    permissionMode: "default",
    editIntervalMs: 10_000, // force reliance on the approval/final paths, not chatty edits
  });

  const seenApprovals = new Set();
  const presser = setInterval(() => {
    const id = pendingApprovalId(slack, seenApprovals);
    if (id === undefined) return;
    console.log(`   … approval card ${id} appeared; pressing "Allow once"`);
    void bridge.handleAction({
      actionId: "approval_allow",
      value: id,
      userId: USER,
      channel: CHANNEL,
    });
  }, 250);

  const deadline = setTimeout(() => {
    console.error("FAIL  timed out waiting for the agent");
    process.exit(1);
  }, 180_000);

  try {
    // ---- Turn 1: a command that must be approved before it can run ----------
    console.log("turn 1: asking Claude to write a file via Bash …");
    await bridge.handleMessage({
      channel: CHANNEL,
      ts: "1",
      user: USER,
      text:
        `Use the Bash tool to run exactly: printf ${WORD} > ${FILE}` +
        "  Then confirm in one short sentence that you did it.",
    });

    check("a permission card was posted", seenApprovals.size >= 1);
    check("the file Claude was asked to write now exists", existsSync(FILE), FILE);
    if (existsSync(FILE)) {
      const content = readFileSync(FILE, "utf8").trim();
      check("the file has the expected content", content === WORD, JSON.stringify(content));
    }

    // ---- Turn 2: same thread, same session — does it remember? -------------
    console.log("turn 2: asking what it just wrote (session memory) …");
    const before = slack.calls.length;
    await bridge.handleMessage({
      channel: CHANNEL,
      ts: "2",
      thread_ts: "1",
      user: USER,
      text: "What word did you write into that file? Reply with just the word.",
    });

    const turn2 = lastRenderedText(slack);
    check(
      "turn 2 answered from the same session's memory",
      turn2.toUpperCase().includes(WORD),
      JSON.stringify(turn2.slice(0, 120)),
    );
    check("turn 2 produced fresh Slack activity", slack.calls.length > before);

    // ---- The turn message was edited in place, not duplicated -------------
    const posts = slack.calls.filter((c) => c.op === "post");
    const turnBodies = posts.filter((c) => /PONG|hello\.txt|wrote|confirm/i.test(c.text ?? ""));
    check("chat output was edited in place (limited posts)", turnBodies.length <= 2, `${turnBodies.length} posts`);
  } finally {
    clearInterval(presser);
    clearTimeout(deadline);
    bridge.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("E2E crashed:", error);
  process.exit(1);
});
