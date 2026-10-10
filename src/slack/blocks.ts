/**
 * Block Kit builders.
 *
 * The bridge's Slack surface is deliberately small: a message that reports a
 * turn, a card that asks permission, and two lists. Everything is built here
 * as plain data so it can be asserted in tests without a Slack workspace.
 */

import type { PendingApproval, StoredSessionInfo } from "../types/index.js";
import { truncate } from "./formatting.js";

export const ACTION_ALLOW = "approval_allow";
export const ACTION_ALWAYS = "approval_always";
export const ACTION_DENY = "approval_deny";

/** Slack block limits: 50 blocks per message, 3000 chars per text block. */
const TEXT_LIMIT = 2900;

function section(text: string, blockId?: string): Record<string, unknown> {
  return {
    type: "section",
    ...(blockId === undefined ? {} : { block_id: blockId }),
    text: { type: "mrkdwn", text: truncate(text, TEXT_LIMIT) },
  };
}

function header(text: string): Record<string, unknown> {
  return { type: "header", text: { type: "plain_text", text: truncate(text, 150) } };
}

/** Render a tool input as an indented code block, bounded in size. */
function inputPreview(input: Record<string, unknown>): string {
  const pretty = JSON.stringify(input, null, 2) ?? String(input);
  return `\`\`\`\n${truncate(pretty, 1800)}\n\`\`\``;
}

/**
 * The permission card.
 *
 * The tool's exact input is shown verbatim: the whole point of asking is that
 * a human can see what would actually run, so paraphrasing it would defeat
 * the control.
 */
export function approvalBlocks(approval: PendingApproval): unknown[] {
  const blocks: unknown[] = [
    section(`:lock: *${approval.toolName}* wants to run`),
    section(inputPreview(approval.input)),
  ];
  if (approval.decisionReason !== undefined && approval.decisionReason !== "") {
    blocks.push(section(`_${approval.decisionReason}_`));
  }
  blocks.push({
    type: "actions",
    block_id: `approval_actions_${approval.id}`,
    elements: [
      {
        type: "button",
        action_id: ACTION_ALLOW,
        style: "primary",
        text: { type: "plain_text", text: "Allow once" },
        value: approval.id,
      },
      {
        type: "button",
        action_id: ACTION_ALWAYS,
        text: { type: "plain_text", text: "Always allow" },
        value: approval.id,
      },
      {
        type: "button",
        action_id: ACTION_DENY,
        style: "danger",
        text: { type: "plain_text", text: "Deny" },
        value: approval.id,
      },
    ],
  });
  return blocks;
}

/** Replace the buttons with a record of the decision. */
export function resolvedApprovalBlocks(
  approval: PendingApproval,
  decision: "allow" | "always" | "deny",
  userId: string,
): unknown[] {
  const verb =
    decision === "deny" ? "Denied" : decision === "always" ? "Always approved" : "Approved";
  return [
    section(`:lock: *${approval.toolName}* — ${verb} by <@${userId}>`),
    section(inputPreview(approval.input)),
  ];
}

/** A status card for `/sessions`. */
export function sessionListBlocks(
  sessions: Array<{
    key: string;
    cwd: string;
    status: string;
    createdAt: number;
    lastActivity: number;
    model?: string;
  }>,
): unknown[] {
  if (sessions.length === 0) return [section("No Claude sessions are running.")];
  const rows = sessions.map((session) => {
    const dot = session.status === "working" ? ":large_blue_circle:" : ":white_circle:";
    const model = session.model === undefined ? "" : ` · \`${session.model}\``;
    return `${dot} \`${session.key}\` · \`${session.cwd}\`${model} · _${session.status}_`;
  });
  return [header("Claude sessions"), section(rows.join("\n"))];
}

function ago(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The `/sessions` card: Claude sessions saved on this machine, from the CLI
 * or the bridge, newest first, with the short id `/resume` accepts.
 *
 * `live` maps a session id to the thread that has it open right now.
 */
export function storedSessionListBlocks(
  sessions: StoredSessionInfo[],
  live: Map<string, string>,
  currentKey: string,
  now: number = Date.now(),
): unknown[] {
  if (sessions.length === 0) return [section("No saved Claude sessions found.")];
  const rows = sessions.map((info) => {
    const owner = live.get(info.sessionId);
    const dot =
      owner === undefined ? ":white_circle:" : owner === currentKey ? ":large_green_circle:" : ":large_blue_circle:";
    const branch = info.gitBranch === undefined || info.gitBranch === "" ? "" : ` · \`${info.gitBranch}\``;
    const where = info.cwd === undefined ? "" : ` · \`${info.cwd}\``;
    const summary = truncate(info.summary.replace(/\s+/g, " "), 80);
    return `${dot} \`${info.sessionId.slice(0, 8)}\` ${summary}\n      ${ago(info.lastModified, now)}${where}${branch}`;
  });
  return [
    header("Claude sessions"),
    section(rows.join("\n")),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: ":large_green_circle: this thread · :large_blue_circle: open in another thread · `/resume <id> [--fork]` to continue one here",
        },
      ],
    },
  ];
}

/** The `/help` card. */
export function helpBlocks(): unknown[] {
  return [
    header("claude-slack-bridge"),
    section(
      [
        "Send any message to talk to Claude in that thread.",
        "",
        "• `/new [path]` — start a fresh session (optionally in another directory)",
        "• `/status` — what this thread's session is doing",
        "• `/stop` — interrupt the current turn",
        "• `/sessions [path]` — list saved Claude sessions (CLI and Slack)",
        "• `/resume <id> [--fork]` — continue a saved session in this thread",
        "• `/handoff` — release this thread's session so the CLI can `claude --resume` it",
        "• `/reset` — forget this thread's session",
        "• `/help` — this message",
      ].join("\n"),
    ),
  ];
}
