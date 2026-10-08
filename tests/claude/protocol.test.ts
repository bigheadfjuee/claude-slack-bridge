import { describe, expect, it } from "vitest";
import { parseSdkMessage } from "../../src/claude/protocol.js";

describe("parseSdkMessage — system/init", () => {
  it("maps init to an init event carrying the session id, model and cwd", () => {
    const out = parseSdkMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-123",
      cwd: "/tmp",
      model: "claude-sonnet-4-5-20250929",
      tools: ["Bash"],
    });
    expect(out).toEqual([
      { type: "init", sessionId: "sess-123", model: "claude-sonnet-4-5-20250929", cwd: "/tmp" },
    ]);
  });

  it("ignores unrelated system subtypes without throwing", () => {
    expect(parseSdkMessage({ type: "system", subtype: "thinking_tokens", tokens: 12 })).toEqual([]);
  });

  it("drops an init that carries no session id", () => {
    expect(parseSdkMessage({ type: "system", subtype: "init", cwd: "/tmp" })).toEqual([]);
  });
});

describe("parseSdkMessage — assistant blocks", () => {
  it("emits a final text event per text block", () => {
    const out = parseSdkMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello there" }] },
    });
    expect(out).toEqual([{ type: "text", text: "hello there", delta: false }]);
  });

  it("captures tool_use as tool activity with id, name and input", () => {
    const out = parseSdkMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_ABC", name: "Bash", input: { command: "echo hi" } },
        ],
      },
    });
    expect(out).toEqual([
      { type: "tool", activity: { id: "toolu_ABC", name: "Bash", input: { command: "echo hi" } } },
    ]);
  });

  it("emits one tool event per tool_use block in a parallel batch", () => {
    const out = parseSdkMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
          { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/b" } },
        ],
      },
    });
    expect(out.map((e) => e.type)).toEqual(["tool", "tool"]);
    expect(out).toEqual([
      { type: "tool", activity: { id: "t1", name: "Read", input: { file_path: "/a" } } },
      { type: "tool", activity: { id: "t2", name: "Read", input: { file_path: "/b" } } },
    ]);
  });

  it("returns every block in order when one message mixes them", () => {
    const out = parseSdkMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
          { type: "text", text: "done" },
        ],
      },
    });
    expect(out.map((e) => e.type)).toEqual(["thinking", "tool", "text"]);
  });
});

describe("parseSdkMessage — tool results", () => {
  it("maps a user tool_result with string content", () => {
    const out = parseSdkMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_ABC",
            content: "BRIDGE_MARKER",
            is_error: false,
          },
        ],
      },
    });
    expect(out).toEqual([
      { type: "tool_result", toolUseId: "toolu_ABC", content: "BRIDGE_MARKER", isError: false },
    ]);
  });

  it("flattens block-array tool_result content into text", () => {
    const out = parseSdkMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_XYZ",
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
            ],
            is_error: true,
          },
        ],
      },
    });
    expect(out).toEqual([
      { type: "tool_result", toolUseId: "toolu_XYZ", content: "line one\nline two", isError: true },
    ]);
  });

  it("ignores echoed plain user text", () => {
    expect(parseSdkMessage({ type: "user", message: { role: "user", content: "hi" } })).toEqual([]);
  });

  it("treats a tool_result with no is_error flag as a success", () => {
    const out = parseSdkMessage({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_PLAIN", content: "ok" }],
      },
    });
    expect(out).toEqual([
      { type: "tool_result", toolUseId: "toolu_PLAIN", content: "ok", isError: false },
    ]);
  });
});

describe("parseSdkMessage — result", () => {
  it("maps a success result and reads snake_case totals", () => {
    const out = parseSdkMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sess-123",
      duration_ms: 1500,
      num_turns: 2,
      total_cost_usd: 0.0123,
      result: "final answer",
    });
    expect(out).toEqual([
      {
        type: "result",
        sessionId: "sess-123",
        isError: false,
        result: "final answer",
        durationMs: 1500,
        numTurns: 2,
        costUsd: 0.0123,
      },
    ]);
  });

  it("marks error results as errored", () => {
    const out = parseSdkMessage({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "sess-9",
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "result", isError: true, sessionId: "sess-9" });
  });

  it("drops a result that carries no session id", () => {
    expect(parseSdkMessage({ type: "result", subtype: "success", is_error: false })).toEqual([]);
  });
});

describe("parseSdkMessage — robustness", () => {
  it("never throws on null, primitives or unknown shapes", () => {
    for (const junk of [null, undefined, 42, "str", {}, [], { type: "mystery" }]) {
      expect(() => parseSdkMessage(junk as unknown)).not.toThrow();
    }
    expect(parseSdkMessage(null)).toEqual([]);
  });

  it("maps partial stream deltas when partial messages are enabled", () => {
    expect(
      parseSdkMessage({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "par" } },
      }),
    ).toEqual([{ type: "text", text: "par", delta: true }]);

    expect(
      parseSdkMessage({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
      }),
    ).toEqual([{ type: "thinking", text: "hmm", delta: true }]);
  });
});
