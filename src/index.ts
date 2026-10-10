/**
 * Process entrypoint.
 *
 * The only file that knows about Bolt or the process lifecycle. Its whole job
 * is construction: build a Socket Mode Slack app, a file-backed auth store and
 * the Agent SDK adapter, hand them to `Bridge`, and then stay out of the way.
 * Keeping Bolt confined here is what lets every other module be tested without
 * a workspace.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { App, type BlockAction, type SlackActionMiddlewareArgs } from "@slack/bolt";
import { Authenticator } from "./auth/authenticator.js";
import { FileAuthStore } from "./auth/store.js";
import { Bridge } from "./bridge/index.js";
import { createQueryFactory, createSessionCatalog } from "./claude/query.js";
import { ClaudeSession } from "./claude/session.js";
import { loadConfig, readConfigFile, resolveWorkdir } from "./config/index.js";
import { ApprovalRegistry } from "./session/approvals.js";
import { SessionLock } from "./session/lock.js";
import type { SessionSpec } from "./session/manager.js";
import { FileThreadStore } from "./session/threads.js";
import { ACTION_ALLOW, ACTION_ALWAYS, ACTION_DENY } from "./slack/blocks.js";
import { SlackClient, type SlackWebLike } from "./slack/client.js";

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

function readMaxSessions(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
}

async function main(): Promise<void> {
  const config = loadConfig({ env: process.env, file: readConfigFile() });

  const botToken = config.slack?.botToken;
  const appToken = config.slack?.appToken;
  if (botToken === undefined || appToken === undefined) {
    // `loadConfig` guarantees these; the guard exists only to satisfy the type.
    throw new Error("Slack credentials missing after configuration load.");
  }

  const workdir = resolveWorkdir(config.workdir, process.env);
  const authFile = join(homedir(), ".claude-slack-bridge", "auth.json");
  const threadsFile = join(homedir(), ".claude-slack-bridge", "threads.json");

  const app = new App({ token: botToken, appToken, socketMode: true });

  // The four WebClient calls we need, behind the interface the bridge expects.
  const web: SlackWebLike = {
    chat: {
      postMessage: (args) => app.client.chat.postMessage(args as never),
      update: (args) => app.client.chat.update(args as never),
      postEphemeral: (args) => app.client.chat.postEphemeral(args as never),
    },
  };

  const auth = new Authenticator({
    allowlist: config.allowedUsers,
    challengeCode: config.challengeCode,
    store: new FileAuthStore(authFile),
  });

  const queryFn = createQueryFactory();
  const bridge = new Bridge({
    slack: new SlackClient(web),
    auth,
    approvals: new ApprovalRegistry(),
    locks: new SessionLock(),
    createSession: (_key, spec: SessionSpec, permissions) => {
      const session = new ClaudeSession(
        {
          cwd: spec.cwd,
          model: spec.model,
          permissionMode: spec.permissionMode,
          resume: spec.resume,
          forkSession: spec.forkSession,
        },
        { queryFn, permissions },
      );
      session.start();
      return session;
    },
    catalog: createSessionCatalog(),
    threads: new FileThreadStore(threadsFile),
    workdir,
    model: config.model,
    permissionMode: config.permissionMode,
    maxSessions: readMaxSessions(process.env.CLAUDE_SLACK_MAX_SESSIONS),
  });

  app.message(async ({ message }) => {
    const m = message as unknown as SlackMessageEvent;
    // Ignore edits, joins, other apps' posts, and anything without text.
    if (m.subtype !== undefined) return;
    if (m.bot_id !== undefined) return;
    if (typeof m.text !== "string" || m.text.trim() === "") return;
    await bridge.handleMessage({
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
    await bridge.handleAction({
      actionId: action.action_id,
      value,
      userId: body.user?.id ?? "",
      channel: body.channel?.id ?? "",
    });
  };

  for (const actionId of [ACTION_ALLOW, ACTION_ALWAYS, ACTION_DENY]) {
    app.action(actionId, onAction);
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received — shutting down.`);
    bridge.stop();
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.start();
  console.log("claude-slack-bridge is running.");
  console.log(`  working directory: ${workdir}`);
  console.log(`  model:             ${config.model ?? "(SDK default)"}`);
  console.log(`  permission mode:   ${config.permissionMode ?? "default"}`);
  console.log(`  pre-authorised:    ${config.allowedUsers?.length ?? 0} user(s)`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`claude-slack-bridge failed to start: ${message}`);
  process.exit(1);
});
