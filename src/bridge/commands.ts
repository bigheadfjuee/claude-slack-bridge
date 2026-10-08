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
    args: rest.split(/\s+/).filter((a) => a.length > 0),
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
    "`/sessions` — list recent Claude sessions on this machine",
    "`/resume <id>` — rebind this thread to an existing session",
    "`/model <name>` — switch model (`opus`, `sonnet`, `haiku`, or a full name)",
    "`/mode <default|acceptEdits|plan|dontAsk|bypassPermissions>` — permission mode",
    "`/cwd <path>` — change the working directory (starts a fresh session)",
    "`/whoami` — your Slack id and authorisation status",
    "",
    "Anything that is not a command is sent to Claude as a prompt.",
    "Replies in a thread continue the same session.",
  ].join("\n");
}
