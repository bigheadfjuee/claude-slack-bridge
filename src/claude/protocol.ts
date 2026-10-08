/**
 * Claude Agent SDK message → bridge event translation.
 *
 * The SDK emits a heterogeneous stream of messages. Everything downstream —
 * Slack rendering, the approval prompt flow, session bookkeeping — consumes
 * the small normalised vocabulary defined by `SessionEvent`. Keeping the
 * translation in one pure function means the whole bridge can be tested
 * without spawning a real agent, and a protocol change is a one-file fix.
 *
 * Field names are snake_case because that is what the SDK actually emits
 * (verified against captured traffic, not assumed).
 */

import type { SessionEvent } from "../types/index.js";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Flatten a tool_result `content` field, which may be a string or blocks. */
function flattenContent(content: unknown): string {
  const direct = str(content);
  if (direct !== undefined) return direct;
  const parts: string[] = [];
  for (const block of asArray(content)) {
    const rec = asRecord(block);
    if (rec === undefined) continue;
    const text = str(rec.text);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n");
}

function parseAssistant(message: Json): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const block of asArray(message.content)) {
    const rec = asRecord(block);
    if (rec === undefined) continue;
    switch (str(rec.type)) {
      case "text": {
        const text = str(rec.text);
        if (text !== undefined && text !== "") events.push({ type: "text", text, delta: false });
        break;
      }
      case "thinking": {
        const text = str(rec.thinking);
        if (text !== undefined && text !== "") events.push({ type: "thinking", text, delta: false });
        break;
      }
      case "tool_use": {
        events.push({
          type: "tool",
          activity: {
            id: str(rec.id),
            name: str(rec.name) ?? "unknown",
            input: asRecord(rec.input) ?? {},
          },
        });
        break;
      }
      default:
        break;
    }
  }
  return events;
}

function parseUser(message: Json): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const block of asArray(message.content)) {
    const rec = asRecord(block);
    if (rec === undefined) continue;
    if (str(rec.type) !== "tool_result") continue;
    const toolUseId = str(rec.tool_use_id);
    if (toolUseId === undefined) continue;
    events.push({
      type: "tool_result",
      toolUseId,
      content: flattenContent(rec.content),
      isError: bool(rec.is_error) ?? false,
    });
  }
  return events;
}

/** Translate one raw SDK message into zero or more normalised events. */
export function parseSdkMessage(raw: unknown): SessionEvent[] {
  const message = asRecord(raw);
  if (message === undefined) return [];

  switch (str(message.type)) {
    case "system": {
      if (str(message.subtype) !== "init") return [];
      const sessionId = str(message.session_id);
      if (sessionId === undefined) return [];
      return [
        {
          type: "init",
          sessionId,
          model: str(message.model),
          cwd: str(message.cwd),
        },
      ];
    }

    case "assistant": {
      const inner = asRecord(message.message);
      return inner === undefined ? [] : parseAssistant(inner);
    }

    case "user": {
      const inner = asRecord(message.message);
      return inner === undefined ? [] : parseUser(inner);
    }

    case "stream_event": {
      const event = asRecord(message.event);
      if (event === undefined) return [];
      const delta = asRecord(event.delta);
      if (delta === undefined) return [];
      switch (str(delta.type)) {
        case "text_delta": {
          const text = str(delta.text);
          return text === undefined || text === "" ? [] : [{ type: "text", text, delta: true }];
        }
        case "thinking_delta": {
          const text = str(delta.thinking);
          return text === undefined || text === "" ? [] : [{ type: "thinking", text, delta: true }];
        }
        default:
          return [];
      }
    }

    case "result": {
      const sessionId = str(message.session_id);
      if (sessionId === undefined) return [];
      return [
        {
          type: "result",
          sessionId,
          isError: bool(message.is_error) ?? str(message.subtype) !== "success",
          result: str(message.result) ?? "",
          costUsd: num(message.total_cost_usd),
          numTurns: num(message.num_turns),
          durationMs: num(message.duration_ms),
        },
      ];
    }

    default:
      return [];
  }
}
