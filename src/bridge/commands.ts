/**
 * Dot-command parsing for Slack messages.
 *
 * A message that starts with `/word` is a command; anything else is chat for
 * Claude. The bar for "is this a command" is deliberately narrow — a bare
 * absolute path like `/usr/local/bin` must never be swallowed as one.
 */

/** Every command the bridge understands. */
export const COMMANDS = [
  "help",
  "stop",
  "new",
  "status",
  "sessions",
  "resume",
  "handoff",
  "model",
  "mode",
  "cwd",
  "whoami",
] as const;

export type CommandName = (typeof COMMANDS)[number];

export interface ParsedCommand {
  name: string;
  args: string[];
}

/** Strip a leading `<@U123>` mention and surrounding whitespace. */
function stripMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, "").trim();
}

/**
 * Unwrap Slack inline formatting from an argument. Copying an id out of a
 * code span (`/sessions` renders them that way) pastes it back with the
 * backticks, so `` `6e72d0a1` `` must still mean `6e72d0a1`.
 */
function unwrapFormatting(arg: string): string {
  let current = arg;
  for (;;) {
    const match = /^([`*_~])(.+)\1$/s.exec(current);
    if (match?.[2] === undefined) return current;
    current = match[2];
  }
}

/**
 * Parse a Slack message as a command.
 *
 * Returns null when the message is ordinary chat, or when the leading token
 * merely looks like one (a filesystem path, a lone slash).
 */
export function parseCommand(text: string): ParsedCommand | null {
  const body = stripMention(text ?? "");
  if (!body.startsWith("/")) return null;

  const spaceIndex = body.search(/\s/);
  const token = spaceIndex === -1 ? body : body.slice(0, spaceIndex);
  const rest = spaceIndex === -1 ? "" : body.slice(spaceIndex + 1);

  // The token must be "/" followed by letters only — no slashes, digits,
  // dots, or dashes. That keeps paths and URLs out.
  if (!/^\/[A-Za-z]+$/.test(token)) return null;

  return {
    name: token.slice(1).toLowerCase(),
    args: rest
      .split(/\s+/)
      .map(unwrapFormatting)
      .filter((a) => a.length > 0),
  };
}

/** Human-readable help text listing every command. */
export function commandHelp(): string {
  return [
    "*/claude-slack-bridge commands*",
    "",
    "`/help` — show this message",
    "`/status` — this conversation's session, model, mode and directory",
    "`/new` — start a fresh Claude session in this thread",
    "`/stop` — interrupt the turn Claude is currently running",
    "`/sessions [path]` — list recent Claude sessions on this machine (CLI and Slack)",
    "`/resume <id|prefix> [--fork]` — continue a saved session in this thread",
    "`/handoff` — release this thread's session and print the `claude --resume` command",
    "`/model <name>` — switch model (`opus`, `sonnet`, `haiku`, or a full name)",
    "`/mode <default|acceptEdits|plan|dontAsk|bypassPermissions>` — permission mode",
    "`/cwd <path>` — change the working directory (starts a fresh session)",
    "`/whoami` — your Slack id and authorisation status",
    "",
    "Anything that is not a command is sent to Claude as a prompt.",
    "Replies in a thread continue the same session.",
  ].join("\n");
}
