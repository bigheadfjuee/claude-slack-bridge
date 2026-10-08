/**
 * Configuration loading.
 *
 * Precedence is environment > file > default, with one deliberate exception:
 * allowlists from both sources are unioned, because a user who adds a
 * colleague to the file should not lose the one they exported in their shell.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig, PermissionMode } from "../types/index.js";

/** Where the bridge looks for its config file. */
export const CONFIG_PATH = join(homedir(), ".claude-slack-bridge", "config.json");

const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
  "auto",
];

export interface LoadConfigInput {
  /** Environment variables (pass `process.env` in production). */
  env?: Record<string, string | undefined>;
  /** Parsed config file contents. */
  file?: BridgeConfig;
  /** Throw when Slack credentials are absent. Default true. */
  validate?: boolean;
}

/** Trim a value, treating whitespace-only strings as absent. */
function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePermissionMode(raw: string | undefined): PermissionMode | undefined {
  if (raw === undefined) return undefined;
  if ((PERMISSION_MODES as readonly string[]).includes(raw)) return raw as PermissionMode;
  throw new Error(
    `Invalid permission mode "${raw}". Expected one of: ${PERMISSION_MODES.join(", ")}.`,
  );
}

/**
 * Build the effective configuration.
 *
 * @throws when `validate` is true and either Slack token is missing.
 */
export function loadConfig(input: LoadConfigInput = {}): BridgeConfig {
  const env = input.env ?? {};
  const file = input.file ?? {};

  const botToken = clean(env.CLAUDE_SLACK_BOT_TOKEN) ?? clean(file.slack?.botToken);
  const appToken = clean(env.CLAUDE_SLACK_APP_TOKEN) ?? clean(file.slack?.appToken);

  if (input.validate !== false) {
    if (botToken === undefined) {
      throw new Error(
        "Missing Slack credentials: set CLAUDE_SLACK_BOT_TOKEN (and CLAUDE_SLACK_APP_TOKEN).",
      );
    }
    if (appToken === undefined) {
      throw new Error(
        "Missing Slack credentials: set CLAUDE_SLACK_APP_TOKEN for Socket Mode.",
      );
    }
  }

  const allowlist = [...new Set([...(file.allowedUsers ?? []), ...splitList(env.CLAUDE_SLACK_ALLOWED_USERS)])];

  const config: BridgeConfig = {
    slack: { botToken, appToken },
    allowedUsers: allowlist,
    challengeCode: clean(env.CLAUDE_SLACK_CHALLENGE_CODE) ?? clean(file.challengeCode),
    workdir: clean(env.CLAUDE_SLACK_WORKDIR) ?? clean(file.workdir),
    model: clean(env.CLAUDE_SLACK_MODEL) ?? clean(file.model),
    permissionMode:
      parsePermissionMode(clean(env.CLAUDE_SLACK_PERMISSION_MODE)) ??
      file.permissionMode ??
      "default",
  };
  return config;
}

/** Read and parse the config file, tolerating its absence. */
export function readConfigFile(path: string = CONFIG_PATH): BridgeConfig {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as BridgeConfig;
  } catch {
    return {};
  }
}

/** Expand a leading `~`, then prefer explicit > env > home. */
export function resolveWorkdir(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
  home: string = homedir(),
): string {
  const raw = explicit ?? clean(env.CLAUDE_SLACK_WORKDIR) ?? home;
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return raw;
}
