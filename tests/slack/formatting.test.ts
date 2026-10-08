import { describe, expect, it } from "vitest";
import {
  formatToolActivity,
  splitMessage,
  toSlackMrkdwn,
  truncate,
} from "../../src/slack/formatting.js";

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("keeps the string when it is exactly the limit", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  it("appends an ellipsis and never exceeds the limit", () => {
    const out = truncate("abcdefghij", 5);
    expect(out).toHaveLength(5);
    expect(out.endsWith("...")).toBe(true);
  });

  it("handles empty input", () => {
    expect(truncate("", 5)).toBe("");
  });
});

describe("toSlackMrkdwn", () => {
  it("converts **bold** to Slack *bold*", () => {
    expect(toSlackMrkdwn("this is **bold** text")).toBe("this is *bold* text");
  });

  it("converts ~~strike~~ to Slack ~strike~", () => {
    expect(toSlackMrkdwn("~~gone~~")).toBe("~gone~");
  });

  it("converts markdown headings to bold lines", () => {
    expect(toSlackMrkdwn("## Title")).toBe("*Title*");
  });

  it("converts [text](url) links to Slack <url|text>", () => {
    expect(toSlackMrkdwn("see [docs](https://example.com)")).toBe(
      "see <https://example.com|docs>",
    );
  });

  it("leaves fenced code blocks byte-for-byte intact", () => {
    const input = "before\n```js\nconst a = **1**;\n```\nafter";
    expect(toSlackMrkdwn(input)).toBe(input);
  });

  it("leaves inline code intact", () => {
    expect(toSlackMrkdwn("use `a ** b` here")).toBe("use `a ** b` here");
  });

  it("escapes Slack control characters in ordinary text", () => {
    expect(toSlackMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("converts list markers to bullets", () => {
    expect(toSlackMrkdwn("- one\n- two")).toBe("• one\n• two");
  });

  it("is idempotent for text that is already mrkdwn-safe", () => {
    const once = toSlackMrkdwn("plain text");
    expect(toSlackMrkdwn(once)).toBe(once);
  });
});

describe("formatToolActivity", () => {
  it("renders the tool name in inline code", () => {
    expect(formatToolActivity({ name: "Read", input: {} })).toBe("🔧 `Read`");
  });

  it("renders a short summary of the arguments", () => {
    const out = formatToolActivity({ name: "Bash", input: { command: "ls -la" } });
    expect(out).toContain("🔧 `Bash`");
    expect(out).toContain("command=ls -la");
  });

  it("truncates long argument values", () => {
    const long = "x".repeat(500);
    const out = formatToolActivity({ name: "Bash", input: { command: long } });
    expect(out.length).toBeLessThan(200);
  });
});

describe("splitMessage", () => {
  it("returns short text as a single chunk", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  it("splits long text so no chunk exceeds the limit", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it("loses no content across the split", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const rejoined = splitMessage(text, 100).join("\n");
    expect(rejoined.replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("never splits inside a fenced code block", () => {
    const body = Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const text = `intro\n\`\`\`js\n${body}\n\`\`\`\noutro`;
    const chunks = splitMessage(text, 200);
    for (const c of chunks) {
      const fences = (c.match(/```/g) ?? []).length;
      expect(fences % 2).toBe(0);
    }
  });

  it("keeps a markdown table in one chunk when it fits", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    const chunks = splitMessage(`x\n${table}\ny`, 1000);
    expect(chunks).toEqual([`x\n${table}\ny`]);
  });

  it("handles empty input", () => {
    expect(splitMessage("", 100)).toEqual([""]);
  });
});
