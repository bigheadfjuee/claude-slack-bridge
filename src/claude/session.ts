/**
 * One live Claude session, driven through the Agent SDK.
 *
 * A Slack conversation maps to exactly one `ClaudeSession`. The session owns a
 * single long-lived SDK query — that is what makes this a *remote control*
 * rather than a series of one-shot invocations: every follow-up message goes
 * into the same process, so the agent keeps its context, its working tree and
 * its pending tool calls between Slack messages.
 *
 * The SDK is reached through an injected `queryFn` so the whole class can be
 * tested against a scripted fake, with no agent, no network and no cost.
 */

import type { PermissionMode, SessionEvent } from "../types/index.js";
import { parseSdkMessage } from "./protocol.js";

/** A user turn pushed into the SDK prompt stream. */
export interface UserTurn {
  type: "user";
  message: { role: "user"; content: Array<{ type: string; text: string }> };
  parent_tool_use_id: string | null;
}

/** The slice of the SDK `Query` object this class depends on. */
export interface QueryLike {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  close(): void;
}

export interface QueryFactoryParams {
  prompt: AsyncIterable<UserTurn>;
  options: Record<string, unknown>;
}

export type QueryFactory = (params: QueryFactoryParams) => QueryLike;

export type PermissionHandler = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface ClaudeSessionOptions {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** Session id to continue, for `claude --resume`. */
  resume?: string;
  extraArgs?: Record<string, string | null>;
}

export interface ClaudeSessionDeps {
  queryFn: QueryFactory;
  permissions?: PermissionHandler;
}

/** A single-consumer async queue: pushes never block, readers await. */
class AsyncQueue<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) {
          return Promise.resolve({ value: buffered, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

export class ClaudeSession {
  private readonly options: ClaudeSessionOptions;
  private readonly deps: ClaudeSessionDeps;
  private readonly out = new AsyncQueue<SessionEvent>();
  private readonly input = new AsyncQueue<UserTurn>();
  private query?: QueryLike;
  private running = false;
  private id?: string;

  constructor(options: ClaudeSessionOptions, deps: ClaudeSessionDeps) {
    this.options = options;
    this.deps = deps;
  }

  /** Normalised events for this session. Iterate to observe output. */
  get events(): AsyncIterable<SessionEvent> {
    return this.out;
  }

  /** Whether the underlying query is open. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Claude's session id, once its init message has arrived. */
  get sessionId(): string | undefined {
    return this.id;
  }

  get cwd(): string {
    return this.options.cwd;
  }

  /** Spawn the query and begin translating its output into events. */
  start(): void {
    if (this.running) return;
    this.running = true;

    const options: Record<string, unknown> = {
      cwd: this.options.cwd,
      model: this.options.model,
      permissionMode: this.options.permissionMode ?? "default",
      includePartialMessages: true,
      extraArgs: this.options.extraArgs,
    };
    if (this.options.resume !== undefined) options.resume = this.options.resume;
    if (this.deps.permissions !== undefined) {
      options.canUseTool = this.deps.permissions;
    }

    this.query = this.deps.queryFn({ prompt: this.input, options });
    void this.pump();
  }

  private async pump(): Promise<void> {
    const query = this.query;
    if (query === undefined) return;
    try {
      for await (const raw of query) {
        for (const event of parse(raw)) {
          if (event.type === "init") this.id = event.sessionId;
          if (event.type === "result") this.id = event.sessionId;
          this.out.push(event);
          // A result closes the turn, not the session: the query stays open
          // so the next Slack message continues the same conversation.
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.out.push({ type: "error", message });
    } finally {
      this.running = false;
      this.input.close();
      this.out.close();
    }
  }

  /** Queue a user turn into the running query. */
  send(text: string): void {
    if (!this.running) throw new Error("ClaudeSession not started");
    this.input.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    });
  }

  /** Ask Claude to stop what it is doing; the session survives. */
  async interrupt(): Promise<void> {
    await this.query?.interrupt();
  }

  /** Change how tool calls are gated for the rest of this session. */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.query?.setPermissionMode(mode);
  }

  /** Switch model mid-session. */
  async setModel(model?: string): Promise<void> {
    await this.query?.setModel(model);
  }

  /** Shut the session down for good. */
  close(): void {
    this.running = false;
    try {
      this.query?.close();
    } finally {
      this.input.close();
      this.out.close();
    }
  }
}

function parse(raw: unknown): SessionEvent[] {
  return parseSdkMessage(raw);
}
