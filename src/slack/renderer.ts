/**
 * Turn rendering.
 *
 * A Claude turn is not a single string: it is an interleaving of streamed
 * deltas, authoritative text blocks, tool calls and a final result. Slack has
 * exactly one message to show for it (one that gets edited in place), so this
 * module folds that event stream into a single body of text.
 *
 * The subtlety worth naming: when partial messages are enabled the SDK emits
 * the same sentence twice — once as `text_delta`s and once as a complete
 * block. Naively appending both duplicates every paragraph, so a final block
 * *replaces* the live buffer it completes rather than following it.
 */

import type { SessionEvent, ToolActivity } from "../types/index.js";
import { formatToolActivity, toSlackMrkdwn, truncate } from "./formatting.js";

/** Default cap for a rendered body, comfortably inside Slack's limits. */
export const DEFAULT_MAX_CHARS = 12_000;

export interface TurnView {
  /** Slack mrkdwn body. */
  text: string;
  /** How many tool calls the turn made. */
  toolCount: number;
  /** Whether the turn ended in failure. */
  isError: boolean;
}

export class TurnTranscript {
  private readonly committed: string[] = [];
  private live: string | undefined;
  private tools = 0;
  private errored = false;

  apply(event: SessionEvent): void {
    switch (event.type) {
      case "text": {
        if (event.delta) {
          this.live = (this.live ?? "") + event.text;
        } else {
          // The authoritative block supersedes any deltas that streamed it.
          this.live = undefined;
          this.push(event.text);
        }
        break;
      }
      case "tool": {
        // Keep prose that streamed before the call, in order.
        if (this.live !== undefined) {
          this.push(this.live);
          this.live = undefined;
        }
        this.tools += 1;
        this.push(formatToolActivity(event.activity));
        break;
      }
      case "error": {
        this.errored = true;
        this.push(`:warning: ${event.message}`);
        break;
      }
      case "result": {
        if (event.isError) {
          this.errored = true;
          this.push(event.result);
        } else if (event.result !== "" && this.committed.length === 0) {
          // Some turns answer entirely in the result field.
          this.push(event.result);
        }
        break;
      }
      default:
        // init / thinking / tool_result carry nothing for the transcript.
        break;
    }
  }

  render(maxChars = DEFAULT_MAX_CHARS): TurnView {
    const body = [...this.committed];
    if (this.live !== undefined && this.live !== "") body.push(this.live);
    return {
      text: truncate(toSlackMrkdwn(body.join("\n\n")), maxChars),
      toolCount: this.tools,
      isError: this.errored,
    };
  }

  private push(text: string): void {
    if (text === "") return;
    this.committed.push(text);
  }
}

/** Fold a complete event list into one view. */
export function renderTurn(events: SessionEvent[], opts: { maxChars?: number } = {}): TurnView {
  const transcript = new TurnTranscript();
  for (const event of events) transcript.apply(event);
  return transcript.render(opts.maxChars ?? DEFAULT_MAX_CHARS);
}

/** Convenience: a one-line description of a tool call, for progress notes. */
export function describeTool(activity: ToolActivity): string {
  return formatToolActivity(activity);
}
