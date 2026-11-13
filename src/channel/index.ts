/**
 * Claude Code channel 的核心邏輯（plugin 模式）。
 *
 * daemon 模式是自己用 Agent SDK 開 session；這裡相反 —— 由使用者已經開著的
 * `claude` CLI 把本程式當 MCP server 啟動，Slack 訊息以 channel 事件推進那個
 * session，Claude 用 `reply` 工具回話，工具審核則經 permission relay 轉成 Slack 卡片。
 *
 * MCP 與 Bolt 都由外部注入，所以整個類別可以不連網測試。
 */

import type { Authenticator } from "../auth/authenticator.js";
import { challengeUser } from "../auth/challenge.js";
import type { IncomingAction, IncomingMessage, SlackLike } from "../bridge/index.js";
import { ACTION_DENY, type ApprovalCard, approvalBlocks, resolvedApprovalBlocks } from "../slack/blocks.js";
import { splitMessage, toSlackMrkdwn } from "../slack/formatting.js";

export const CHANNEL_INSTRUCTIONS = [
  'Slack messages arrive as <channel source="slack-bridge" chat_id="..." thread_ts="..." user="...">.',
  "The sender is on Slack and cannot see this terminal: anything they should read must be sent with the",
  "reply tool, passing chat_id and thread_ts from the tag. Write replies in normal Markdown.",
].join(" ");

export const REPLY_TOOL = {
  name: "reply",
  description: "Send a message back to the Slack conversation a channel event came from",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: { type: "string", description: "chat_id from the <channel> tag" },
      thread_ts: { type: "string", description: "thread_ts from the <channel> tag" },
      text: { type: "string", description: "The message, in Markdown" },
    },
    required: ["chat_id", "text"],
  },
} as const;

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

export interface ChannelDeps {
  slack: SlackLike;
  auth: Authenticator;
  /** 送一則 MCP notification 給 Claude Code。 */
  notify: (method: string, params: Record<string, unknown>) => Promise<void>;
}

export class SlackChannel {
  private readonly deps: ChannelDeps;
  /** 已授權使用者發過訊息的頻道 —— `reply` 只准回到這些地方。 */
  private readonly chats = new Set<string>();
  /** 最近一次對話，審核卡片貼在這裡。 */
  private last?: { channel: string; threadTs: string };
  // ponytail: 終端機先回答的請求不會被清掉；每筆只有幾百 bytes，量大再加 TTL。
  private readonly pending = new Map<string, { approval: ApprovalCard; channel: string; ts: string }>();

  constructor(deps: ChannelDeps) {
    this.deps = deps;
  }

  /** Slack 訊息 → channel 事件。未授權者只會收到挑戰提示，內容不會進 session。 */
  async handleMessage(message: IncomingMessage): Promise<void> {
    const text = (message.text ?? "").trim();
    if (!this.deps.auth.isAuthorized(message.user)) {
      await challengeUser(this.deps.auth, this.deps.slack, message.user, message.channel, text);
      return;
    }
    const threadTs = message.thread_ts ?? message.ts;
    this.chats.add(message.channel);
    this.last = { channel: message.channel, threadTs };
    await this.deps.notify("notifications/claude/channel", {
      content: text,
      meta: { chat_id: message.channel, thread_ts: threadTs, user: message.user },
    });
  }

  /** `reply` 工具：把 Claude 的 Markdown 轉成 mrkdwn 後貼回 Slack。 */
  async reply(args: { chat_id?: unknown; thread_ts?: unknown; text?: unknown }): Promise<void> {
    const { chat_id: channel, thread_ts: threadTs, text } = args;
    if (typeof channel !== "string" || typeof text !== "string") {
      throw new Error("reply needs chat_id and text");
    }
    // 信任邊界：模型不能把訊息貼到沒有授權使用者開過口的頻道。
    if (!this.chats.has(channel)) {
      throw new Error(`chat_id ${channel} has not messaged this session`);
    }
    for (const chunk of splitMessage(toSlackMrkdwn(text))) {
      await this.deps.slack.postMessage({
        channel,
        text: chunk,
        threadTs: typeof threadTs === "string" ? threadTs : undefined,
      });
    }
  }

  /** Claude Code 開出權限對話框時呼叫：在最近的對話貼審核卡片。 */
  async handlePermissionRequest(request: PermissionRequest): Promise<void> {
    if (this.last === undefined) return; // 還沒有人從 Slack 講過話，只能在終端機回答。
    const { channel, threadTs } = this.last;
    const approval: ApprovalCard = {
      id: request.request_id,
      toolName: request.tool_name,
      input: { input: request.input_preview },
      decisionReason: request.description,
    };
    const ts = await this.deps.slack.postMessage({
      channel,
      threadTs,
      text: `${approval.toolName} needs approval`,
      blocks: approvalBlocks(approval, false),
    });
    this.pending.set(approval.id, { approval, channel, ts });
  }

  /** 審核按鈕：與發話同等權限，未授權者不能放行。 */
  async handleAction(action: IncomingAction): Promise<void> {
    if (!this.deps.auth.isAuthorized(action.userId)) {
      await this.deps.slack.postEphemeral({
        channel: action.channel,
        user: action.userId,
        text: ":lock: You're not authorised to approve tool calls for this bridge.",
      });
      return;
    }
    const entry = this.pending.get(action.value);
    if (entry === undefined) {
      await this.deps.slack.postEphemeral({
        channel: action.channel,
        user: action.userId,
        text: ":warning: That approval is no longer pending.",
      });
      return;
    }
    this.pending.delete(action.value);
    const behavior = action.actionId === ACTION_DENY ? "deny" : "allow";
    await this.deps.notify("notifications/claude/channel/permission", {
      request_id: action.value,
      behavior,
    });
    await this.deps.slack.updateMessage({
      channel: entry.channel,
      ts: entry.ts,
      text: `${entry.approval.toolName} ${behavior === "deny" ? "denied" : "approved"}`,
      blocks: resolvedApprovalBlocks(entry.approval, behavior, action.userId),
    });
  }
}
