/**
 * Slack routing: map a Slack message to the conversation it belongs to.
 *
 * The rule mirrors pi-slack-bridge: a thread is the unit of conversation.
 * A top-level message in a channel starts (or reuses) the session keyed by
 * that message's own `ts`; a reply inside a thread joins the thread's session.
 */

/** The subset of a Slack message the router cares about. */
export interface RoutableMessage {
  channel: string;
  /** Present on replies; absent on top-level messages. */
  thread_ts?: string;
  /** The message's own timestamp. */
  ts: string;
}

/**
 * Build the routing key for a message.
 *
 * Returns `channel/threadTs` where `threadTs` is the thread the message
 * belongs to — the parent's timestamp for replies, the message's own for
 * top-level posts — so every turn in one Slack thread shares one key.
 */
export function conversationKey(message: RoutableMessage): string {
  const threadTs = message.thread_ts ?? message.ts;
  return `${message.channel}/${threadTs}`;
}

/** Split a routing key back into its parts. */
export function parseConversationKey(key: string): { channel: string; threadTs: string } {
  const idx = key.indexOf("/");
  if (idx < 0) {
    throw new Error(`malformed conversation key: ${key}`);
  }
  return { channel: key.slice(0, idx), threadTs: key.slice(idx + 1) };
}

/**
 * True when a message is a reply inside a thread (as opposed to a
 * thread-starting top-level post).
 */
export function isThreadReply(message: RoutableMessage): boolean {
  return typeof message.thread_ts === "string" && message.thread_ts !== message.ts;
}
