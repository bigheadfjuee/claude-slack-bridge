/**
 * Registry of live permission questions.
 *
 * When Claude wants to run a tool that needs a decision, the SDK blocks on a
 * promise. We park that promise here, post approval buttons to Slack, and
 * resolve it when the human clicks. Anything still pending when a
 * conversation is reset is denied rather than leaked.
 */

import { randomBytes } from "node:crypto";
import type { PendingApproval, PermissionDecision } from "../types/index.js";

export type ApprovalDecision = { kind: "allow" } | { kind: "deny"; reason?: string };

export interface ApprovalRequest {
  channel: string;
  threadTs: string;
  toolName: string;
  input: Record<string, unknown>;
  decisionReason?: string;
  resolve: (decision: PermissionDecision) => void;
}

/** Conversation key for a pending request, matching the routing scheme. */
function keyOf(channel: string, threadTs: string): string {
  return `${channel}/${threadTs}`;
}

function newId(): string {
  // base64url of 8 bytes -> 11 url-safe chars, comfortably unique per process.
  return randomBytes(8).toString("base64url");
}

export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>();

  /** Park a request and return the record Slack will render. */
  register(request: ApprovalRequest): PendingApproval {
    const approval: PendingApproval = {
      id: newId(),
      channel: request.channel,
      threadTs: request.threadTs,
      toolName: request.toolName,
      input: request.input,
      decisionReason: request.decisionReason,
      resolve: request.resolve as PendingApproval["resolve"],
      createdAt: Date.now(),
    };
    this.pending.set(approval.id, approval);
    return approval;
  }

  /** Look up a pending request by the id that travelled through Slack. */
  get(id: string): PendingApproval | undefined {
    return this.pending.get(id);
  }

  /**
   * Settle a pending request.
   *
   * Returns false when the id is unknown or was already settled, so a
   * double-click cannot resolve the same promise twice.
   */
  decide(id: string, decision: ApprovalDecision): boolean {
    const approval = this.pending.get(id);
    if (approval === undefined) return false;
    this.pending.delete(id);
    if (decision.kind === "allow") {
      approval.resolve({ behavior: "allow", updatedInput: approval.input });
    } else {
      approval.resolve({
        behavior: "deny",
        message: decision.reason?.trim() ? decision.reason : "Denied from Slack.",
      });
    }
    return true;
  }

  /** Deny everything still pending for one conversation; returns how many. */
  cancelAll(conversationKey: string): number {
    let count = 0;
    for (const [id, approval] of [...this.pending]) {
      if (keyOf(approval.channel, approval.threadTs) !== conversationKey) continue;
      this.decide(id, { kind: "deny", reason: "Cancelled: the conversation was reset." });
      count += 1;
    }
    return count;
  }

  /** Pending requests, optionally narrowed to one conversation. */
  list(conversationKey?: string): PendingApproval[] {
    const all = [...this.pending.values()];
    if (conversationKey === undefined) return all;
    return all.filter((a) => keyOf(a.channel, a.threadTs) === conversationKey);
  }

  size(): number {
    return this.pending.size;
  }
}
