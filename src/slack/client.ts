/**
 * The bridge's whole contract with Slack.
 *
 * Isolating the four WebClient calls we need behind one class means the rest
 * of the codebase never imports Bolt, and every Slack interaction is testable
 * against a fake. It also gives rate limiting a single place to live.
 */

export interface SlackWebLike {
  chat: {
    postMessage(args: Record<string, unknown>): Promise<unknown>;
    update(args: Record<string, unknown>): Promise<unknown>;
    postEphemeral(args: Record<string, unknown>): Promise<unknown>;
  };
}

export interface PostMessageArgs {
  channel: string;
  text: string;
  threadTs?: string;
  blocks?: unknown[];
}

export interface UpdateMessageArgs {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}

export interface PostEphemeralArgs {
  channel: string;
  user: string;
  text: string;
  blocks?: unknown[];
}

export interface SlackClientOptions {
  /** Sleep implementation, injected so retry tests run instantly. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Extra attempts after the first rate-limit rejection. */
  maxRetries?: number;
}

/** Slack's rate-limit error, however it reaches us. */
function isRateLimited(error: unknown): { retryAfterMs: number } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; retryAfter?: unknown };
  if (candidate.code !== "slack_webapi_rate_limited") return undefined;
  const seconds = typeof candidate.retryAfter === "number" ? candidate.retryAfter : 1;
  return { retryAfterMs: Math.max(0, seconds) * 1000 };
}

export class SlackClient {
  private readonly web: SlackWebLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(web: SlackWebLike, options: SlackClientOptions = {}) {
    this.web = web;
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        const limited = isRateLimited(error);
        if (limited === undefined || attempt === this.maxRetries) {
          lastError = error;
          break;
        }
        await this.sleep(limited.retryAfterMs);
      }
    }
    throw lastError;
  }

  /** Post a message, returning its timestamp. */
  async postMessage(args: PostMessageArgs): Promise<string> {
    const payload: Record<string, unknown> = { channel: args.channel, text: args.text };
    if (args.threadTs !== undefined) payload.thread_ts = args.threadTs;
    if (args.blocks !== undefined) payload.blocks = args.blocks;
    const result = (await this.withRetry(() => this.web.chat.postMessage(payload))) as {
      ts?: unknown;
    };
    return typeof result?.ts === "string" ? result.ts : "";
  }

  /** Edit a message already posted. */
  async updateMessage(args: UpdateMessageArgs): Promise<void> {
    const payload: Record<string, unknown> = {
      channel: args.channel,
      ts: args.ts,
      text: args.text,
    };
    if (args.blocks !== undefined) payload.blocks = args.blocks;
    await this.withRetry(() => this.web.chat.update(payload));
  }

  /** Send a message only one user can see. */
  async postEphemeral(args: PostEphemeralArgs): Promise<void> {
    const payload: Record<string, unknown> = {
      channel: args.channel,
      user: args.user,
      text: args.text,
    };
    if (args.blocks !== undefined) payload.blocks = args.blocks;
    await this.withRetry(() => this.web.chat.postEphemeral(payload));
  }
}
