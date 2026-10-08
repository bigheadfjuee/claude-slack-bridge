import { describe, expect, it } from "vitest";
import {
  ACTION_ALLOW,
  ACTION_ALWAYS,
  ACTION_DENY,
  approvalBlocks,
  helpBlocks,
  resolvedApprovalBlocks,
  sessionListBlocks,
} from "../../src/slack/blocks.js";
import type { PendingApproval } from "../../src/types/index.js";

const pending = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: "abc123",
  channel: "C1",
  threadTs: "111.222",
  toolName: "Bash",
  input: { command: "rm -rf /tmp/scratch" },
  resolve: () => {},
  createdAt: 0,
  ...over,
});

/** Flatten every action element in a block list for easy assertions. */
function actions(blocks: unknown[]) {
  return blocks
    .filter((b): b is { type: string; elements?: unknown[] } => {
      return typeof b === "object" && b !== null && (b as { type?: string }).type === "actions";
    })
    .flatMap((b) => b.elements ?? [])
    .map((e) => e as { action_id: string; value?: string; text?: { text: string } });
}

describe("approvalBlocks", () => {
  it("names the tool and shows exactly what it wants to run", () => {
    const blocks = approvalBlocks(pending());
    const dump = JSON.stringify(blocks);
    expect(dump).toContain("Bash");
    expect(dump).toContain("rm -rf /tmp/scratch");
  });

  it("offers allow, always-allow and deny as three buttons", () => {
    const els = actions(approvalBlocks(pending()));
    expect(els.map((e) => e.action_id)).toEqual([ACTION_ALLOW, ACTION_ALWAYS, ACTION_DENY]);
  });

  it("carries the approval id in every button value so clicks are unambiguous", () => {
    const els = actions(approvalBlocks(pending({ id: "xyz789" })));
    expect(els.map((e) => e.value)).toEqual(["xyz789", "xyz789", "xyz789"]);
  });

  it("includes the SDK's stated reason when it gave one", () => {
    const blocks = approvalBlocks(pending({ decisionReason: "writes outside the repo" }));
    expect(JSON.stringify(blocks)).toContain("writes outside the repo");
  });

  it("truncates an enormous tool input instead of blowing the block limit", () => {
    const blocks = approvalBlocks(pending({ input: { command: "y".repeat(20_000) } }));
    const text = JSON.stringify(blocks);
    expect(text.length).toBeLessThan(3500);
  });

  it("gives every block a unique id", () => {
    const ids = approvalBlocks(pending())
      .map((b) => (b as { block_id?: string }).block_id)
      .filter((id): id is string => typeof id === "string");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolvedApprovalBlocks", () => {
  it("drops the buttons once the question is settled", () => {
    const blocks = resolvedApprovalBlocks(pending(), "allow", "U123");
    expect(actions(blocks)).toHaveLength(0);
  });

  it("records who decided and what they decided", () => {
    const text = JSON.stringify(resolvedApprovalBlocks(pending(), "allow", "U123"));
    expect(text).toContain("U123");
    expect(text.toLowerCase()).toContain("approv");
  });

  it("says denied when it was denied", () => {
    const text = JSON.stringify(resolvedApprovalBlocks(pending(), "deny", "U999")).toLowerCase();
    expect(text).toContain("den");
  });
});

describe("sessionListBlocks", () => {
  it("explains the empty case rather than rendering a blank list", () => {
    const text = JSON.stringify(sessionListBlocks([])).toLowerCase();
    expect(text).toContain("no");
  });

  it("shows one row per session with its status", () => {
    const blocks = sessionListBlocks([
      { key: "C1/aaa", cwd: "/work", status: "working", createdAt: 1, lastActivity: 2 },
      { key: "C2/bbb", cwd: "/srv", status: "idle", createdAt: 3, lastActivity: 4, model: "claude-opus-4-1" },
    ]);
    const text = JSON.stringify(blocks);
    expect(text).toContain("/work");
    expect(text).toContain("/srv");
    expect(text.toLowerCase()).toContain("working");
    expect(text.toLowerCase()).toContain("idle");
    expect(text).toContain("claude-opus-4-1");
  });
});

describe("helpBlocks", () => {
  it("lists the commands the bridge actually implements", () => {
    const text = JSON.stringify(helpBlocks());
    for (const command of ["new", "status", "stop", "sessions", "help"]) {
      expect(text).toContain(command);
    }
  });
});
