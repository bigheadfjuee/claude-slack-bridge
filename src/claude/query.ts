/**
 * The one place the Agent SDK is actually touched.
 *
 * Everything else in the codebase depends on the small `QueryLike` interface
 * from `session.ts`, which keeps the SDK — a moving target — behind a single
 * adapter. `buildQueryOptions` and `toUserTurn` are exported separately so the
 * mapping can be unit-tested without spawning an agent.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeSessionOptions,
  PermissionHandler,
  QueryLike,
  UserTurn,
} from "./session.js";

/** Map a session spec onto the SDK's options object. */
export function buildQueryOptions(
  spec: ClaudeSessionOptions,
  canUseTool?: PermissionHandler,
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    cwd: spec.cwd,
    permissionMode: spec.permissionMode ?? "default",
    includePartialMessages: true,
  };
  if (spec.model !== undefined) options.model = spec.model;
  if (spec.resume !== undefined) options.resume = spec.resume;
  if (spec.extraArgs !== undefined) options.extraArgs = spec.extraArgs;
  if (canUseTool !== undefined) options.canUseTool = canUseTool;
  return options;
}

/** Wrap a line of text as a user turn for the SDK's streaming prompt input. */
export function toUserTurn(text: string): UserTurn {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

/**
 * The real `queryFn`.
 *
 * The SDK's `query()` returns an object that is both an async iterable of
 * messages and the control surface (interrupt / setPermissionMode / close).
 * We hand back a structurally-typed view of it so `ClaudeSession` never has to
 * import the SDK's own types.
 */
export function createQueryFactory(): (
  params: { prompt: AsyncIterable<UserTurn>; options: Record<string, unknown> },
) => QueryLike {
  return ({ prompt, options }) => {
    const q = query({
      prompt: prompt as AsyncIterable<never>,
      options: options as never,
    });
    return {
      [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() as AsyncIterator<unknown>,
      interrupt: () => q.interrupt(),
      setPermissionMode: (mode) => q.setPermissionMode(mode as never),
      setModel: (model) => q.setModel(model as never),
      close: () => q.close(),
    };
  };
}
