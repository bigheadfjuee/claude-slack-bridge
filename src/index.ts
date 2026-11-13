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
import { createSlackApp, wireSlackHandlers } from "./slack/app.js";
import { SlackClient } from "./slack/client.js";

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

  const { app, web } = createSlackApp(botToken, appToken);

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

  wireSlackHandlers(app, bridge);

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
