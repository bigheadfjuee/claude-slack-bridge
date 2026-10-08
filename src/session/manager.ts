/**
 * Conversation → Claude session registry.
 *
 * Slack is stateless: every message arrives with a channel and an optional
 * thread root, and it is up to us to decide which long-running Claude session
 * it belongs to. That mapping lives here, together with the policy that keeps
 * the number of live agents bounded — a laptop should not accumulate fifty
 * Claude processes because fifty threads were tried once.
 *
 * Two rules matter:
 *
 *  - Eviction is least-recently-used, and a session that is mid-turn is never
 *    evicted. Killing an agent that is halfway through editing a file is a
 *    data-loss bug, not a cache miss, so we fail loudly instead.
 *  - A session is addressed by conversation key, never by Slack's own ids,
 *    so the policy stays independent of the platform's threading model.
 */

import type { ClaudeSession } from "../claude/session.js";
import type { PermissionMode } from "../types/index.js";

export type SessionStatus = "idle" | "working";

export interface SessionSpec {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resume?: string;
}

export interface ManagedSession {
  key: string;
  session: ClaudeSession;
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  status: SessionStatus;
  createdAt: number;
  lastActivity: number;
  /** Claude's own session id, learned from its init message. */
  claudeSessionId?: string;
}

export interface SessionSummary {
  key: string;
  cwd: string;
  model?: string;
  status: SessionStatus;
  createdAt: number;
  lastActivity: number;
}

export interface SessionManagerOptions {
  maxSessions: number;
  now?: () => number;
  create: (key: string, spec: SessionSpec) => ClaudeSession;
}

export class SessionManager {
  private readonly records = new Map<string, ManagedSession>();
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly create: (key: string, spec: SessionSpec) => ClaudeSession;

  constructor(options: SessionManagerOptions) {
    this.maxSessions = Math.max(1, options.maxSessions);
    this.now = options.now ?? (() => Date.now());
    this.create = options.create;
  }

  get size(): number {
    return this.records.size;
  }

  get(key: string): ManagedSession | undefined {
    return this.records.get(key);
  }

  /** Fetch the conversation's session, spawning one on first contact. */
  getOrCreate(key: string, spec: SessionSpec): ClaudeSession {
    const existing = this.records.get(key);
    if (existing !== undefined) {
      existing.lastActivity = this.now();
      return existing.session;
    }

    this.makeRoom();

    const session = this.create(key, spec);
    const now = this.now();
    this.records.set(key, {
      key,
      session,
      cwd: spec.cwd,
      model: spec.model,
      permissionMode: spec.permissionMode,
      status: "idle",
      createdAt: now,
      lastActivity: now,
    });
    return session;
  }

  /** Note that a conversation was used, for LRU purposes. */
  touch(key: string): void {
    const record = this.records.get(key);
    if (record !== undefined) record.lastActivity = this.now();
  }

  markWorking(key: string): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    record.status = "working";
    record.lastActivity = this.now();
  }

  markIdle(key: string): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    record.status = "idle";
    record.lastActivity = this.now();
  }

  recordSessionId(key: string, claudeSessionId: string): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    record.claudeSessionId = claudeSessionId;
  }

  list(): SessionSummary[] {
    return [...this.records.values()].map((record) => ({
      key: record.key,
      cwd: record.cwd,
      model: record.model,
      status: record.status,
      createdAt: record.createdAt,
      lastActivity: record.lastActivity,
    }));
  }

  remove(key: string): boolean {
    const record = this.records.get(key);
    if (record === undefined) return false;
    record.session.close();
    this.records.delete(key);
    return true;
  }

  stopAll(): void {
    for (const record of this.records.values()) record.session.close();
    this.records.clear();
  }

  /**
   * Free a slot if we are at the cap.
   *
   * Candidates are idle sessions, oldest activity first. If every session is
   * busy we refuse rather than kill work in progress.
   */
  private makeRoom(): void {
    while (this.records.size >= this.maxSessions) {
      const victim = [...this.records.values()]
        .filter((record) => record.status === "idle")
        .sort((a, b) => a.lastActivity - b.lastActivity)[0];
      if (victim === undefined) {
        throw new Error("all Claude sessions are busy; cannot start another");
      }
      this.remove(victim.key);
    }
  }
}
