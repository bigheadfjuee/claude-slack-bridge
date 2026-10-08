import { describe, expect, it } from "vitest";
import { renderTurn, TurnTranscript } from "../../src/slack/renderer.js";
import type { SessionEvent } from "../../src/types/index.js";

const text = (t: string, delta = false): SessionEvent => ({ type: "text", text: t, delta });
const tool = (name: string, input: Record<string, unknown>): SessionEvent => ({
  type: "tool",
  activity: { name, input },
});
const result = (over: Partial<Extract<SessionEvent, { type: "result" }>> = {}): SessionEvent => ({
  type: "result",
  sessionId: "s1",
  isError: false,
  result: "",
  ...over,
});

describe("TurnTranscript", () => {
  it("starts empty", () => {
    expect(new TurnTranscript().render()).toEqual({ text: "", toolCount: 0, isError: false });
  });

  it("commits a final text block", () => {
    const t = new TurnTranscript();
    t.apply(text("hello"));
    expect(t.render().text).toBe("hello");
  });

  it("concatenates successive final blocks with a blank line", () => {
    const t = new TurnTranscript();
    t.apply(text("first"));
    t.apply(text("second"));
    expect(t.render().text).toBe("first\n\nsecond");
  });

  it("shows streamed deltas live", () => {
    const t = new TurnTranscript();
    t.apply(text("Hel", true));
    t.apply(text("lo", true));
    expect(t.render().text).toBe("Hello");
  });

  it("replaces the live buffer with the final block instead of duplicating it", () => {
    const t = new TurnTranscript();
    t.apply(text("Hel", true));
    t.apply(text("lo", true));
    t.apply(text("Hello")); // the authoritative block that follows the deltas
    expect(t.render().text).toBe("Hello");
  });

  it("keeps earlier committed text when a later block streams in", () => {
    const t = new TurnTranscript();
    t.apply(text("part one"));
    t.apply(text("part two ", true));
    t.apply(text("part two"));
    expect(t.render().text).toBe("part one\n\npart two");
  });

  it("renders tool activity as a single line and counts it", () => {
    const t = new TurnTranscript();
    t.apply(text("let me look"));
    t.apply(tool("Read", { file_path: "/etc/hosts" }));
    const view = t.render();
    expect(view.toolCount).toBe(1);
    expect(view.text).toContain("Read");
    expect(view.text).toContain("/etc/hosts");
  });

  it("summarises a tool call compactly without dumping whole inputs", () => {
    const t = new TurnTranscript();
    t.apply(tool("Bash", { command: "printf '%s' " + "x".repeat(400) }));
    const line = t.render().text;
    expect(line.length).toBeLessThan(200);
    expect(line).toContain("Bash");
  });

  it("ignores thinking blocks by default", () => {
    const t = new TurnTranscript();
    t.apply({ type: "thinking", text: "secret reasoning", delta: false });
    expect(t.render().text).toBe("");
  });

  it("marks the turn as errored only for failed results", () => {
    const ok = new TurnTranscript();
    ok.apply(result({ isError: false }));
    expect(ok.render().isError).toBe(false);

    const bad = new TurnTranscript();
    bad.apply(result({ isError: true, result: "boom" }));
    expect(bad.render().isError).toBe(true);
  });

  it("surfaces an error event in the body", () => {
    const t = new TurnTranscript();
    t.apply({ type: "error", message: "sdk exploded" });
    const view = t.render();
    expect(view.isError).toBe(true);
    expect(view.text).toContain("sdk exploded");
  });

  it("does not lose text that arrived after a tool call", () => {
    const t = new TurnTranscript();
    t.apply(tool("Bash", { command: "ls" }));
    t.apply(text("all done"));
    expect(t.render().text).toContain("all done");
  });
});

describe("renderTurn", () => {
  it("renders a whole event list in one pass", () => {
    const view = renderTurn([text("hi"), tool("Bash", { command: "ls" }), result()]);
    expect(view.text).toContain("hi");
    expect(view.toolCount).toBe(1);
    expect(view.isError).toBe(false);
  });

  it("translates markdown to Slack mrkdwn", () => {
    const view = renderTurn([text("# Title\n\n**bold** and `code`")]);
    expect(view.text).toContain("*Title*");
    expect(view.text).toContain("*bold*");
    expect(view.text).toContain("`code`");
    expect(view.text).not.toContain("**bold**");
  });

  it("leaves fenced code blocks untouched", () => {
    const view = renderTurn([text("```js\nconst a = **not bold**;\n```")]);
    expect(view.text).toContain("**not bold**");
  });

  it("caps the body at the requested length", () => {
    const view = renderTurn([text("z".repeat(50_000))], { maxChars: 1000 });
    expect(view.text.length).toBeLessThanOrEqual(1000);
  });

  it("never exceeds Slack's own message limit by default", () => {
    const view = renderTurn([text("z".repeat(100_000))]);
    expect(view.text.length).toBeLessThanOrEqual(39_000);
  });
});
