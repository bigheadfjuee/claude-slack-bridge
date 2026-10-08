/**
 * Slack mrkdwn formatting helpers.
 *
 * Claude emits GitHub-flavoured Markdown; Slack speaks a slightly different
 * dialect ("mrkdwn"). These helpers translate without destroying code, and
 * split long answers into Slack-sized chunks without breaking fences.
 */

import type { ToolActivity } from "../types/index.js";

/** Hard cap Slack accepts for a single text block. */
export const SLACK_TEXT_LIMIT = 2900;

/** Shorten a string to `limit` characters, ending with an ellipsis if cut. */
export function truncate(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  if (limit <= 3) return ".".repeat(limit);
  return `${text.slice(0, limit - 3)}...`;
}

/** Escape the three characters Slack treats as markup. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert one non-code span of Markdown into Slack mrkdwn. */
function convertSpan(span: string): string {
  return escapeSlack(span)
    .replace(/^(#{1,6})\s+(.*)$/gm, "*$2*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
    .replace(/^[-*]\s+/gm, "• ");
}

/**
 * Translate Markdown to Slack mrkdwn.
 *
 * Fenced code blocks and inline code are passed through byte-for-byte so
 * indentation and markup inside them survive untouched.
 */
export function toSlackMrkdwn(markdown: string): string {
  if (!markdown) return "";
  const parts: string[] = [];
  // Match ```-fences (with optional language tag) or `inline code`.
  const tokenizer = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;
  let last = 0;
  let match = tokenizer.exec(markdown);
  while (match !== null) {
    if (match.index > last) {
      parts.push(convertSpan(markdown.slice(last, match.index)));
    }
    parts.push(match[1] ?? "");
    last = match.index + (match[1] ?? "").length;
    match = tokenizer.exec(markdown);
  }
  if (last < markdown.length) parts.push(convertSpan(markdown.slice(last)));
  return parts.join("");
}

/** Render a single tool invocation as a one-line Slack status. */
export function formatToolActivity(activity: ToolActivity, limit = 160): string {
  const head = `🔧 \`${activity.name}\``;
  const entries = Object.entries(activity.input ?? {});
  if (entries.length === 0) return head;
  const parts = entries.map(([key, value]) => {
    const rendered =
      typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    return `${key}=${truncate(rendered.replace(/\s+/g, " ").trim(), 60)}`;
  });
  return truncate(`${head} ${parts.join(", ")}`, limit);
}

/**
 * Split a long message into Slack-sized chunks.
 *
 * Breaks land on line boundaries. A chunk never ends with an unclosed code
 * fence: the fence is closed before a break and reopened after it, so every
 * chunk renders as valid mrkdwn on its own.
 */
export function splitMessage(text: string, limit = SLACK_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  let fence: string | null = null;

  const flush = (): void => {
    chunks.push(current);
    current = "";
  };

  for (const line of lines) {
    const candidate = current === "" ? line : `${current}\n${line}`;
    if (candidate.length <= limit) {
      current = candidate;
    } else if (fence !== null) {
      // Break inside a code block: close the fence, reopen it after.
      chunks.push(`${current}\n\`\`\``);
      current = `${fence}\n${line}`;
    } else {
      flush();
      current = line;
    }
    if (/^\s*```/.test(line)) {
      fence = fence === null ? line.trimEnd() : null;
    }
  }
  flush();
  return chunks;
}
