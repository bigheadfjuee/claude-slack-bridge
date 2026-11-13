/**
 * Bolt（Socket Mode）的組裝，daemon 與 channel plugin 共用。
 *
 * 專案中唯一 import Bolt 的地方：建立 App、套用公司 proxy、把訊息與按鈕事件
 * 整理成 handlers 需要的最小欄位。
 */

import {
  App,
  type BlockAction,
  type SlackActionMiddlewareArgs,
  SocketModeReceiver,
} from "@slack/bolt";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import type { IncomingAction, IncomingMessage } from "../bridge/index.js";
import { ACTION_ALLOW, ACTION_ALWAYS, ACTION_DENY } from "./blocks.js";
import type { SlackWebLike } from "./client.js";

export interface SlackHandlers {
  handleMessage(message: IncomingMessage): Promise<void>;
  handleAction(action: IncomingAction): Promise<void>;
}

/** A message event, narrowed to the fields the bridge cares about. */
interface SlackMessageEvent {
  channel: string;
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
}

/** Strip a leading `<@U123>` mention, so the bot's own name never reaches Claude. */
function stripLeadingMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, "");
}

export function createSlackApp(botToken: string, appToken: string): { app: App; web: SlackWebLike } {
  // 公司網路需經 proxy：Slack 套件內建的 undici 不吃 NODE_USE_ENV_PROXY，
  // 所以手動依 HTTPS_PROXY / NO_PROXY 建 dispatcher，同時給 Web API 與 WebSocket 用。
  const proxied =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const dispatcher = proxied ? new EnvHttpProxyAgent({ allowH2: false }) : undefined;
  if (dispatcher) setGlobalDispatcher(dispatcher);
  const app = new App({ token: botToken, receiver: new SocketModeReceiver({ appToken, dispatcher }) });

  // The four WebClient calls we need, behind the interface the bridge expects.
  const web: SlackWebLike = {
    chat: {
      postMessage: (args) => app.client.chat.postMessage(args as never),
      update: (args) => app.client.chat.update(args as never),
      postEphemeral: (args) => app.client.chat.postEphemeral(args as never),
    },
  };
  return { app, web };
}

/** 把 Slack 事件接到 handlers（必須在 `app.start()` 之前呼叫）。 */
export function wireSlackHandlers(app: App, handlers: SlackHandlers): void {
  app.message(async ({ message }) => {
    const m = message as unknown as SlackMessageEvent;
    // Ignore edits, joins, other apps' posts, and anything without text.
    if (m.subtype !== undefined) return;
    if (m.bot_id !== undefined) return;
    if (typeof m.text !== "string" || m.text.trim() === "") return;
    await handlers.handleMessage({
      channel: m.channel,
      ts: m.ts,
      user: m.user ?? "",
      text: stripLeadingMention(m.text),
      thread_ts: m.thread_ts,
    });
  });

  const onAction = async ({
    ack,
    action,
    body,
  }: SlackActionMiddlewareArgs<BlockAction>): Promise<void> => {
    // Acknowledge inside Slack's three-second window, then do the real work.
    await ack();
    // Only some Block Kit elements carry a `value`; guard before reading it.
    const value = "value" in action && typeof action.value === "string" ? action.value : "";
    await handlers.handleAction({
      actionId: action.action_id,
      value,
      userId: body.user?.id ?? "",
      channel: body.channel?.id ?? "",
    });
  };

  for (const actionId of [ACTION_ALLOW, ACTION_ALWAYS, ACTION_DENY]) {
    app.action(actionId, onAction);
  }
}
