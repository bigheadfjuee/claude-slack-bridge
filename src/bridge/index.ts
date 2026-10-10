/**
 * The bridge core.
 *
 * Everything the bridge does to a single Slack message funnels through here:
 * deciding who may talk to it, routing the message to a conversation, keeping
 * one Claude session per conversation, streaming that session's output back as
 * a single edited Slack message, and turning tool-permission questions into
 * buttons a human can press.
 *
 * Design notes worth keeping:
 *
 *  - One Slack message per turn, edited in place. Editing on every streamed
 *    token would blow through Slack's rate limit, so edits are throttled — but
 *    a tool call, an error, and the turn's end always update immediately,
 *    because those are the moments a reader cares about.
 *  - A conversation is locked for the duration of a turn. A second message
 *    arriving mid-turn is told the thread is busy rather than queued, because
 *    silently interleaving two prompts into one agent is worse than waiting.
 *  - Slack failures never wedge a conversation: the lock is released and the
 *    session marked idle in a `finally`, so one bad turn cannot make a thread
 *    permanently unusable.
 */

import type { Authenticator } from "../auth/authenticator.js";
import type { ClaudeSession, PermissionHandler } from "../claude/session.js";
import {
  type ApprovalDecision,
  ApprovalRegistry,
  type ApprovalRequest,
} from "../session/approvals.js";
import { SessionLock } from "../session/lock.js";
import { SessionManager, type SessionSpec } from "../session/manager.js";
import { conversationKey, parseConversationKey } from "../session/routing.js";
import { MemoryThreadStore, type ThreadStore } from "../session/threads.js";
import {
  ACTION_ALWAYS,
  ACTION_DENY,
  approvalBlocks,
  helpBlocks,
  resolvedApprovalBlocks,
  storedSessionListBlocks,
} from "../slack/blocks.js";
import { TurnTranscript } from "../slack/renderer.js";
import type {
  PermissionDecision,
  PermissionMode,
  SessionCatalog,
  StoredSessionInfo,
} from "../types/index.js";
import { type ParsedCommand, parseCommand } from "./commands.js";

/** The Slack operations the bridge performs. */
export interface SlackLike {
  postMessage(args: {
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: unknown[];
  }): Promise<string>;
  updateMessage(args: {
    channel: string;
    ts: string;
    text: string;
    blocks?: unknown[];
  }): Promise<void>;
  postEphemeral(args: { channel: string; user: string; text: string; blocks?: unknown[] }): Promise<void>;
}

export interface BridgeDeps {
  slack: SlackLike;
  auth: Authenticator;
  approvals: ApprovalRegistry;
  locks: SessionLock;
  /** Build a real (or fake) Claude session for a conversation. */
  createSession: (
    key: string,
    spec: SessionSpec,
    permissions: PermissionHandler,
  ) => ClaudeSession;
  /** Claude sessions saved on disk, for `/sessions` and `/resume`. */
  catalog?: SessionCatalog;
  /** Which Claude session each thread last used, kept across restarts. */
  threads?: ThreadStore;
  workdir: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** Minimum gap between streamed edits, in milliseconds. */
  editIntervalMs?: number;
  maxSessions?: number;
  now?: () => number;
}

/** A Slack message routed to the bridge. */
export interface IncomingMessage {
  channel: string;
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
}

/** A Block Kit button press. */
export interface IncomingAction {
  actionId: string;
  value: string;
  userId: string;
  channel: string;
}

/** Per-turn bookkeeping. */
interface TurnHandle {
  channel: string;
  threadTs: string;
  transcript: TurnTranscript;
  slackTs?: string;
  lastEditAt: number;
  lastRendered: string;
  finalised: boolean;
}

const DEFAULT_EDIT_INTERVAL_MS = 1200;
const SESSION_LIST_LIMIT = 15;
/** How far back a short id prefix is searched. */
const PREFIX_SEARCH_LIMIT = 500;
const EMPTY_CATALOG: SessionCatalog = {
  list: async () => [],
  get: async () => undefined,
};

interface Override {
  cwd?: string;
  resume?: string;
  forkSession?: boolean;
}
const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

export class Bridge {
  readonly sessions: SessionManager;
  readonly approvals: ApprovalRegistry;

  private readonly deps: BridgeDeps;
  private readonly locks: SessionLock;
  private readonly now: () => number;
  private readonly editIntervalMs: number;
  private readonly handles = new Map<string, TurnHandle>();
  /** Slack ts of each approval card, so we can edit it when it is settled. */
  private readonly approvalMessages = new Map<string, string>();
  /** Options to apply the next time a conversation's session is created. */
  private readonly overrides = new Map<string, Override>();
  private readonly catalog: SessionCatalog;
  private readonly threads: ThreadStore;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    this.locks = deps.locks;
    this.approvals = deps.approvals;
    this.now = deps.now ?? Date.now;
    this.editIntervalMs = deps.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
    this.catalog = deps.catalog ?? EMPTY_CATALOG;
    this.threads = deps.threads ?? new MemoryThreadStore();
    this.sessions = new SessionManager({
      maxSessions: deps.maxSessions ?? 8,
      now: this.now,
      create: (key, spec) =>
        deps.createSession(key, spec, (toolName, input) =>
          this.permissionHandler(key, toolName, input),
        ),
    });
  }

  /**
   * Handle an incoming Slack message.
   *
   * Resolves once the turn it triggered has finished (or once it has been
   * refused), which keeps callers — and tests — simple.
   */
  async handleMessage(message: IncomingMessage): Promise<void> {
    const text = (message.text ?? "").trim();
    const key = conversationKey(message);

    if (!this.deps.auth.isAuthorized(message.user)) {
      await this.challenge(message.user, message.channel, text);
      return;
    }

    const command = parseCommand(text);
    if (command !== null) {
      await this.runCommand(command, {
        channel: message.channel,
        threadTs: message.thread_ts ?? message.ts,
        key,
        user: message.user,
      });
      return;
    }

    if (text === "") return;

    await this.runTurn({
      channel: message.channel,
      threadTs: message.thread_ts ?? message.ts,
      key,
      user: message.user,
      text,
    });
  }

  /** Handle a permission button press. */
  async handleAction(action: IncomingAction): Promise<void> {
    // Approving a tool run is as privileged as issuing the prompt: a stranger
    // in the channel must not be able to wave a dangerous command through.
    if (!this.deps.auth.isAuthorized(action.userId)) {
      await this.deps.slack.postEphemeral({
        channel: action.channel,
        user: action.userId,
        text: ":lock: You're not authorised to approve tool calls for this bridge.",
      });
      return;
    }

    const approval = this.approvals.get(action.value);
    if (approval === undefined) {
      await this.deps.slack.postEphemeral({
        channel: action.channel,
        user: action.userId,
        text: ":warning: That approval is no longer pending — it may have expired or been resolved.",
      });
      return;
    }

    const kind: "allow" | "always" | "deny" =
      action.actionId === ACTION_DENY
        ? "deny"
        : action.actionId === ACTION_ALWAYS
          ? "always"
          : "allow";

    const decision: ApprovalDecision =
      kind === "deny" ? { kind: "deny" } : { kind: "allow" };
    this.approvals.decide(action.value, decision);

    const ts = this.approvalMessages.get(action.value);
    if (ts !== undefined) {
      await this.deps.slack.updateMessage({
        channel: approval.channel,
        ts,
        text: `Permission ${kind === "deny" ? "denied" : "granted"} for ${approval.toolName}`,
        blocks: resolvedApprovalBlocks(approval, kind, action.userId),
      });
      this.approvalMessages.delete(action.value);
    }

    if (kind === "always") {
      const key = `${approval.channel}/${approval.threadTs}`;
      await this.sessions.get(key)?.session.setPermissionMode("acceptEdits");
    }
  }

  /** Shut down every session, denying anything still waiting on a human. */
  stop(): void {
    this.approvals.cancelAll(""); // "" matches nothing; approvals are per-conversation
    for (const record of this.sessions.list()) this.approvals.cancelAll(record.key);
    this.sessions.stopAll();
  }

  // ---------------------------------------------------------------- turn flow

  private async runTurn(ctx: {
    channel: string;
    threadTs: string;
    key: string;
    user: string;
    text: string;
  }): Promise<void> {
    const acquired = await this.locks.acquire(ctx.key);
    if (!acquired) {
      await this.deps.slack.postEphemeral({
        channel: ctx.channel,
        user: ctx.user,
        text: ":hourglass: Claude is still busy in this thread. Wait for it to finish, or send `/stop`.",
      });
      return;
    }

    this.sessions.markWorking(ctx.key);
    let handle: TurnHandle | undefined;
    try {
      // Only work out a spec when a session must actually be spawned: it
      // consumes the thread's pending override and may touch the disk.
      const existing = this.sessions.get(ctx.key)?.session;
      const session =
        existing ?? this.sessions.getOrCreate(ctx.key, await this.specFor(ctx.key));
      handle = {
        channel: ctx.channel,
        threadTs: ctx.threadTs,
        transcript: new TurnTranscript(),
        lastEditAt: 0,
        lastRendered: "",
        finalised: false,
      };
      this.handles.set(ctx.key, handle);
      session.send(ctx.text);
      // Acknowledge straight away: the user should see that Claude picked the
      // message up, even before the first token streams back.
      await this.flush(handle, true);
      await this.consume(ctx.key, session, handle);
    } catch (error) {
      await this.reportFailure(ctx, error, handle);
    } finally {
      this.handles.delete(ctx.key);
      this.sessions.markIdle(ctx.key);
      this.locks.release(ctx.key);
    }
  }

  private async consume(key: string, session: ClaudeSession, handle: TurnHandle): Promise<void> {
    try {
      for await (const event of session.events) {
        await this.onEvent(key, event, handle);
        if (event.type === "result") break;
      }
    } finally {
      if (!handle.finalised) await this.finalise(handle);
    }
  }

  private async onEvent(
    key: string,
    event: import("../types/index.js").SessionEvent,
    handle: TurnHandle,
  ): Promise<void> {
    switch (event.type) {
      case "init":
        this.bindSession(key, event.sessionId);
        return;
      case "text":
        handle.transcript.apply(event);
        await this.flush(handle, !event.delta);
        return;
      case "tool":
        handle.transcript.apply(event);
        await this.flush(handle, true);
        return;
      case "error":
        handle.transcript.apply(event);
        await this.flush(handle, true);
        return;
      case "result":
        handle.transcript.apply(event);
        await this.finalise(handle);
        return;
      default:
        return;
    }
  }

  /** Post or edit the turn's Slack message, subject to the throttle. */
  private async flush(handle: TurnHandle, force: boolean): Promise<void> {
    const view = handle.transcript.render();
    const text = view.text.trim() === "" ? "_(working…)_" : view.text;
    if (handle.slackTs === undefined) {
      // First write of the turn: post immediately, so the user sees that
      // Claude picked the message up before the first token arrives.
      handle.slackTs = await this.deps.slack.postMessage({
        channel: handle.channel,
        threadTs: handle.threadTs,
        text,
      });
      handle.lastRendered = text;
      handle.lastEditAt = this.now();
      return;
    }
    if (!force && this.now() - handle.lastEditAt < this.editIntervalMs) return;
    if (text === handle.lastRendered) return;
    await this.deps.slack.updateMessage({ channel: handle.channel, ts: handle.slackTs, text });
    handle.lastRendered = text;
    handle.lastEditAt = this.now();
  }

  /** Guarantee a final, untruncated-by-throttle update. */
  private async finalise(handle: TurnHandle): Promise<void> {
    if (handle.finalised) return;
    handle.finalised = true;
    const view = handle.transcript.render();
    const text = view.text.trim() === "" ? "_(no output)_" : view.text;
    if (handle.slackTs === undefined) {
      handle.slackTs = await this.deps.slack.postMessage({
        channel: handle.channel,
        threadTs: handle.threadTs,
        text,
      });
    } else {
      await this.deps.slack.updateMessage({  channel: handle.channel, ts: handle.slackTs, text });
    }
    handle.lastRendered = text;
    handle.lastEditAt = this.now();
  }

  /**
   * Decide how a conversation's session is spawned.
   *
   * An explicit `/resume` or `/cwd` wins. Failing that, a thread that has
   * talked to Claude before — before a restart, or before a `/handoff` to the
   * CLI — resumes the session it was bound to, provided the transcript still
   * exists; a binding to a deleted session is dropped so the thread is not
   * wedged on a resume that can never succeed.
   */
  private async specFor(key: string): Promise<SessionSpec> {
    const base = {
      model: this.deps.model,
      permissionMode: this.deps.permissionMode ?? "default",
    } as const;

    const override = this.overrides.get(key);
    this.overrides.delete(key);
    if (override !== undefined) {
      return {
        ...base,
        cwd: override.cwd ?? this.deps.workdir,
        resume: override.resume,
        forkSession: override.forkSession,
      };
    }

    const binding = this.threads.get(key);
    if (binding !== undefined) {
      const info = await this.catalog.get(binding.sessionId).catch(() => undefined);
      if (info !== undefined) {
        return { ...base, cwd: info.cwd ?? binding.cwd, resume: binding.sessionId };
      }
      this.threads.delete(key);
    }

    return { ...base, cwd: this.deps.workdir };
  }

  /** Remember the Claude session a thread is talking to, in memory and on disk. */
  private bindSession(key: string, sessionId: string): void {
    this.sessions.recordSessionId(key, sessionId);
    const record = this.sessions.get(key);
    if (record === undefined) return;
    this.threads.set(key, { sessionId, cwd: record.cwd, updatedAt: this.now() });
  }

  /** The thread key that has `sessionId` open right now, if any. */
  private liveOwner(sessionId: string): string | undefined {
    for (const summary of this.sessions.list()) {
      if (this.sessions.get(summary.key)?.claudeSessionId === sessionId) return summary.key;
    }
    return undefined;
  }

  /** Find a stored session by full id or unambiguous prefix. */
  private async findStoredSession(
    idOrPrefix: string,
  ): Promise<{ match?: StoredSessionInfo; candidates: StoredSessionInfo[] }> {
    const exact = await this.catalog.get(idOrPrefix).catch(() => undefined);
    if (exact !== undefined) return { match: exact, candidates: [exact] };
    const candidates = (await this.catalog.list({ limit: PREFIX_SEARCH_LIMIT })).filter((info) =>
      info.sessionId.startsWith(idOrPrefix),
    );
    return { match: candidates.length === 1 ? candidates[0] : undefined, candidates };
  }

  /** Drop a thread's live session and everything waiting on it. */
  private detach(key: string): void {
    this.approvals.cancelAll(key);
    this.sessions.remove(key);
  }

  // ------------------------------------------------------------- permissions

  /**
   * Answer a tool-permission question by asking Slack.
   *
   * The promise we return is what the SDK blocks on, so it must always settle:
   * a stale id, a reset, or a shutdown all resolve it (as a denial) rather than
   * leaving the agent hung.
   */
  private permissionHandler(
    key: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    const { channel, threadTs } = parseConversationKey(key);
    let settle!: (decision: PermissionDecision) => void;
    const decision = new Promise<PermissionDecision>((resolve) => {
      settle = resolve;
    });

    const request: ApprovalRequest = {
      channel,
      threadTs,
      toolName,
      input,
      resolve: settle,
    };
    const pending = this.approvals.register(request);

    void (async () => {
      const ts = await this.deps.slack.postMessage({
        channel,
        threadTs,
        text: `Claude wants to run \`${toolName}\``,
        blocks: approvalBlocks(pending),
      });
      this.approvalMessages.set(pending.id, ts);
    })();

    return decision;
  }

  // ---------------------------------------------------------------- commands

  private async runCommand(
    command: ParsedCommand,
    ctx: { channel: string; threadTs: string; key: string; user: string },
  ): Promise<void> {
    switch (command.name) {
      case "help":
        await this.reply(ctx, "*claude-slack-bridge* commands:", helpBlocks());
        return;

      case "status": {
        const record = this.sessions.get(ctx.key);
        if (record === undefined) {
          await this.say(ctx, "This thread has no session yet — send a message to start one.");
          return;
        }
        await this.say(
          ctx,
          [
            `*cwd:* \`${record.cwd}\``,
            `*model:* ${record.model ?? "(default)"}`,
            `*mode:* \`${record.permissionMode ?? "default"}\``,
            `*status:* ${record.status}`,
            record.claudeSessionId === undefined ? "" : `*session:* \`${record.claudeSessionId}\``,
            record.claudeSessionId === undefined
              ? ""
              : `*continue in CLI:* \`/handoff\`, then \`${resumeCommand(record.cwd, record.claudeSessionId)}\``,
          ]
            .filter((line) => line !== "")
            .join("\n"),
        );
        return;
      }

      case "stop": {
        const record = this.sessions.get(ctx.key);
        if (record === undefined || !this.locks.isBusy(ctx.key)) {
          await this.say(ctx, "Nothing is running in this thread right now.");
          return;
        }
        await record.session.interrupt();
        await this.say(ctx, ":octagonal_sign: Stopping the current turn.");
        return;
      }

      case "reset":
        this.detach(ctx.key);
        this.threads.delete(ctx.key);
        await this.say(ctx, "Forgot this thread's session. The next message starts fresh.");
        return;

      case "new":
        this.detach(ctx.key);
        this.threads.delete(ctx.key);
        await this.say(ctx, "Fresh session ready — send your next message to start it.");
        return;

      case "sessions": {
        const dir = command.args[0];
        let stored: StoredSessionInfo[];
        try {
          stored = await this.catalog.list({ dir, limit: SESSION_LIST_LIMIT });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.say(ctx, `:warning: Could not list Claude sessions: ${message}`);
          return;
        }
        const live = new Map<string, string>();
        for (const summary of this.sessions.list()) {
          const id = this.sessions.get(summary.key)?.claudeSessionId;
          if (id !== undefined) live.set(id, summary.key);
        }
        await this.reply(ctx, "Claude sessions", storedSessionListBlocks(stored, live, ctx.key));
        return;
      }

      case "whoami":
        await this.say(
          ctx,
          `You are <@${ctx.user}>; authorised: ${this.deps.auth.isAuthorized(ctx.user) ? "yes" : "no"}.`,
        );
        return;

      case "model": {
        const record = this.sessions.get(ctx.key);
        if (record === undefined) {
          await this.say(ctx, "This thread has no session yet — send a message to start one.");
          return;
        }
        const model = command.args[0];
        if (model === undefined) {
          await this.say(ctx, `Current model: \`${record.model ?? "(default)"}\`.`);
          return;
        }
        await record.session.setModel(model);
        record.model = model;
        await this.say(ctx, `Switched this session to \`${model}\`.`);
        return;
      }

      case "mode": {
        const record = this.sessions.get(ctx.key);
        if (record === undefined) {
          await this.say(ctx, "This thread has no session yet — send a message to start one.");
          return;
        }
        const raw = command.args[0] as PermissionMode | undefined;
        if (raw === undefined) {
          await this.say(ctx, `Current mode: \`${record.permissionMode ?? "default"}\`.`);
          return;
        }
        if (!PERMISSION_MODES.includes(raw)) {
          await this.say(ctx, `Unknown mode \`${raw}\`. Try one of: ${PERMISSION_MODES.join(", ")}.`);
          return;
        }
        await record.session.setPermissionMode(raw);
        record.permissionMode = raw;
        await this.say(ctx, `Switched this session to \`${raw}\`.`);
        return;
      }

      case "cwd": {
        const path = command.args[0];
        if (path === undefined) {
          await this.say(ctx, "Usage: `/cwd <absolute-path>`.");
          return;
        }
        this.overrides.set(ctx.key, { cwd: path });
        this.detach(ctx.key);
        this.threads.delete(ctx.key);
        await this.say(ctx, `Working directory set to \`${path}\`. The next message starts a fresh session there.`);
        return;
      }

      case "resume": {
        const fork = command.args.includes("--fork");
        const id = command.args.find((arg) => arg !== "--fork");
        if (id === undefined) {
          await this.say(ctx, "Usage: `/resume <session-id|prefix> [--fork]` — see `/sessions` for ids.");
          return;
        }
        if (this.locks.isBusy(ctx.key)) {
          await this.say(ctx, "Claude is busy in this thread — `/stop` it or wait before resuming.");
          return;
        }

        let found: { match?: StoredSessionInfo; candidates: StoredSessionInfo[] };
        try {
          found = await this.findStoredSession(id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.say(ctx, `:warning: Could not look up Claude sessions: ${message}`);
          return;
        }
        const { match, candidates } = found;
        if (match === undefined) {
          await this.say(
            ctx,
            candidates.length === 0
              ? `No Claude session matches \`${id}\`. Try \`/sessions\`.`
              : `\`${id}\` matches ${candidates.length} sessions — use more characters:\n${candidates
                  .slice(0, 10)
                  .map((info) => `• \`${info.sessionId}\` ${info.summary}`)
                  .join("\n")}`,
          );
          return;
        }

        // Two live agents appending to one transcript would interleave their
        // turns; a fork gets its own id and is always safe.
        const owner = this.liveOwner(match.sessionId);
        if (!fork && owner !== undefined && owner !== ctx.key) {
          await this.say(
            ctx,
            `Session \`${match.sessionId}\` is already open in another thread. Run \`/handoff\` there first, or use \`/resume ${id} --fork\`.`,
          );
          return;
        }

        const cwd = match.cwd ?? this.deps.workdir;
        this.detach(ctx.key);
        this.overrides.set(ctx.key, {
          cwd,
          resume: match.sessionId,
          ...(fork ? { forkSession: true } : {}),
        });
        await this.say(
          ctx,
          [
            fork
              ? `:twisted_rightwards_arrows: The next message will *fork* \`${match.sessionId}\` into a new session.`
              : `:arrow_right_hook: The next message will resume \`${match.sessionId}\`.`,
            `*cwd:* \`${cwd}\``,
            `*topic:* ${match.summary}`,
            fork
              ? ""
              : "_If this session is still open in a terminal, exit it there first — or use `--fork`._",
          ]
            .filter((line) => line !== "")
            .join("\n"),
        );
        return;
      }

      case "handoff": {
        const record = this.sessions.get(ctx.key);
        const sessionId = record?.claudeSessionId ?? this.threads.get(ctx.key)?.sessionId;
        const cwd = record?.cwd ?? this.threads.get(ctx.key)?.cwd;
        if (sessionId === undefined || cwd === undefined) {
          await this.say(ctx, "This thread has no Claude session to hand off yet.");
          return;
        }
        if (this.locks.isBusy(ctx.key)) {
          await this.say(ctx, "Claude is still working in this thread — `/stop` it or wait for the turn to finish.");
          return;
        }
        // Close our end so the CLI is the only writer. The thread binding is
        // kept, so the next Slack message here resumes whatever the CLI left.
        this.detach(ctx.key);
        await this.say(
          ctx,
          [
            ":handshake: Released this session. Continue it in a terminal with:",
            `\`\`\`${resumeCommand(cwd, sessionId)}\`\`\``,
            "Reply in this thread later to pick it back up here.",
          ].join("\n"),
        );
        return;
      }

      default:
        await this.say(ctx, `Unknown command \`/${command.name}\`. Try \`/help\`.`);
    }
  }

  // ------------------------------------------------------------------ replies

  private async say(
    ctx: { channel: string; threadTs: string },
    text: string,
    blocks?: unknown[],
  ): Promise<void> {
    await this.deps.slack.postMessage({
      channel: ctx.channel,
      threadTs: ctx.threadTs,
      text,
      ...(blocks === undefined ? {} : { blocks }),
    });
  }

  private async reply(
    ctx: { channel: string; threadTs: string },
    text: string,
    blocks?: unknown[],
  ): Promise<void> {
    await this.say(ctx, text, blocks);
  }

  private async challenge(userId: string, channel: string, text: string): Promise<void> {
    if (text !== "" && this.deps.auth.verify(userId, text)) {
      await this.deps.slack.postEphemeral({
        channel,
        user: userId,
        text: ":white_check_mark: You're authorised — send a message to start talking to Claude.",
      });
      return;
    }
    await this.deps.slack.postEphemeral({
      channel,
      user: userId,
      text: [
        ":lock: You're not authorised to use this bridge.",
        this.deps.auth.hasPendingChallenge(userId)
          ? "Send the challenge code you were given to get access."
          : "Ask the bridge operator for the challenge code, then send it here.",
      ].join(" "),
    });
  }

  private async reportFailure(
    ctx: { channel: string; user: string },
    error: unknown,
    handle: TurnHandle | undefined,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const text = `:warning: Could not run Claude: ${message}`;
    try {
      if (handle?.slackTs !== undefined) {
        await this.deps.slack.updateMessage({
          channel: handle.channel,
          ts: handle.slackTs,
          text,
        });
        handle.finalised = true;
      } else {
        await this.deps.slack.postMessage({ channel: ctx.channel, threadTs: "", text });
      }
    } catch {
      // Never let a failure to report a failure escape.
    }
  }
}

/** A shell line that reopens a session in the Claude CLI. */
function resumeCommand(cwd: string, sessionId: string): string {
  const quoted = /^[\w@%+=:,./-]+$/.test(cwd) ? cwd : `'${cwd.replace(/'/g, "'\\''")}'`;
  return `cd ${quoted} && claude --resume ${sessionId}`;
}
