/**
 * Shared types for the Slack ⇄ Claude Code bridge.
 */

/** Permission modes accepted by the Claude Agent SDK. */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "bypassPermissions"
  | "auto";

/** Result of a permission question asked through `canUseTool`. */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** A live question from Claude, waiting for a human to approve or deny. */
export interface PendingApproval {
  /** Short id used in Slack button `value` fields. */
  id: string;
  /** Slack channel the requesting thread lives in. */
  channel: string;
  /** Slack thread timestamp the request belongs to. */
  threadTs: string;
  /** Tool the agent wants to run (e.g. `Bash`, `Write`). */
  toolName: string;
  /** Tool input as proposed by the agent. */
  input: Record<string, unknown>;
  /** Why the SDK says this call needs a decision, when it says anything. */
  decisionReason?: string;
  /** Resolves the `canUseTool` promise. */
  resolve: (decision: PermissionDecision) => void;
  /** Epoch milliseconds the request was created. */
  createdAt: number;
}

/** Persisted bridge configuration. */
export interface BridgeConfig {
  slack?: {
    botToken?: string;
    appToken?: string;
  };
  /** Slack user IDs that skip the challenge-code handshake. */
  allowedUsers?: string[];
  /** One-time code a new user must send before the bridge will talk to them. */
  challengeCode?: string;
  /** Working directory used for new sessions. */
  workdir?: string;
  /** Default model for new sessions. */
  model?: string;
  /** Default permission mode for new sessions. */
  permissionMode?: PermissionMode;
}

/** Everything needed to start (or resume) one Claude session. */
export interface SessionOptions {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resume?: string;
  /** Extra CLI flags forwarded verbatim, e.g. `{ "add-dir": "/tmp" }`. */
  extraArgs?: Record<string, string | null>;
}

/** A tool invocation observed in the agent's output stream. */
export interface ToolActivity {
  name: string;
  input: Record<string, unknown>;
  /** Tool use id, when the SDK reports one. */
  id?: string;
}

/** Normalised events the bridge consumes from a Claude session. */
export type SessionEvent =
  | { type: "init"; sessionId: string; model?: string; cwd?: string }
  | { type: "text"; text: string; delta: boolean }
  | { type: "thinking"; text: string; delta: boolean }
  | { type: "tool"; activity: ToolActivity }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | {
      type: "result";
      sessionId: string;
      isError: boolean;
      result: string;
      costUsd?: number;
      numTurns?: number;
      durationMs?: number;
    }
  | { type: "error"; message: string };

/** A Slack-side conversation bound to one Claude session. */
export interface SessionRecord {
  /** Slack routing key this session answers on. */
  key: string;
  channel: string;
  threadTs: string;
  /** Claude session id, once the first turn produced one. */
  sessionId?: string;
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  createdAt: number;
  lastUsedAt: number;
  turns: number;
}
