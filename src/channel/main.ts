#!/usr/bin/env node
/**
 * Channel plugin 的進入點：由 Claude Code 以 stdio MCP server 的方式啟動。
 *
 *   Slack ⇄ (Socket Mode) 本程式 ⇄ (stdio MCP) 執行中的 claude CLI session
 */

// stdout 是 MCP 通道，任何非協定輸出都會弄壞它 —— Bolt 的 log 一律改走 stderr。
console.log = console.info = console.debug = console.error;

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Authenticator } from "../auth/authenticator.js";
import { FileAuthStore } from "../auth/store.js";
import { loadConfig, readConfigFile } from "../config/index.js";
import { createSlackApp, wireSlackHandlers } from "../slack/app.js";
import { SlackClient } from "../slack/client.js";
import { CHANNEL_INSTRUCTIONS, type PermissionRequest, REPLY_TOOL, SlackChannel } from "./index.js";

// Bolt 背景重連失敗會變成 unhandled rejection；記錄即可，不要讓 MCP server 跟著死。
process.on("unhandledRejection", (error) => console.error("slack-bridge channel:", error));

const stateDir = join(homedir(), ".claude-slack-bridge");

// plugin 的工作目錄是使用者的專案，不是這個 repo，所以 token 放在家目錄的 .env。
// 已存在的環境變數優先（loadEnvFile 不會覆蓋）。
const envFile = join(stateDir, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const mcp = new Server(
  { name: "slack-bridge", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {}, "claude/channel/permission": {} },
      tools: {},
    },
    instructions: CHANNEL_INSTRUCTIONS,
  },
);

// Slack 連線失敗時 MCP 仍要能回應，錯誤才看得到；所以 channel 延後建立。
let channel: SlackChannel | undefined;

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [REPLY_TOOL] }));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== REPLY_TOOL.name) throw new Error(`unknown tool: ${request.params.name}`);
  if (channel === undefined) throw new Error("Slack is not connected — check the MCP server's stderr");
  await channel.reply(request.params.arguments ?? {});
  return { content: [{ type: "text", text: "sent" }] };
});

// permission_request 是 Claude Code 的擴充方法，SDK 沒有對應 schema，用 fallback 接。
mcp.fallbackNotificationHandler = async (notification) => {
  if (notification.method !== "notifications/claude/channel/permission_request") return;
  await channel?.handlePermissionRequest(notification.params as unknown as PermissionRequest);
};

await mcp.connect(new StdioServerTransport());

// plugin 啟用後「每個」claude session 都會啟動本程式；Socket Mode 多條連線會互搶事件，
// 訊息就可能掉進沒有載入 channel 的 session。所以只有明確指定的那個 session 才連 Slack。
if (process.env.CLAUDE_SLACK_CHANNEL !== "1") {
  console.error("slack-bridge channel: idle (set CLAUDE_SLACK_CHANNEL=1 to connect this session to Slack).");
} else try {
  const config = loadConfig({ env: process.env, file: readConfigFile() });
  const { app, web } = createSlackApp(config.slack?.botToken ?? "", config.slack?.appToken ?? "");
  channel = new SlackChannel({
    slack: new SlackClient(web),
    auth: new Authenticator({
      allowlist: config.allowedUsers,
      challengeCode: config.challengeCode,
      store: new FileAuthStore(join(stateDir, "auth.json")),
    }),
    notify: (method, params) => mcp.notification({ method, params } as never),
  });
  wireSlackHandlers(app, channel);
  await app.start();
  console.error("slack-bridge channel: connected to Slack.");

  // Claude Code 結束時會關掉 stdin；跟著收掉 Socket Mode 連線。
  mcp.onclose = () => void app.stop().finally(() => process.exit(0));
} catch (error) {
  console.error(`slack-bridge channel: Slack is unavailable: ${error instanceof Error ? error.message : error}`);
}
