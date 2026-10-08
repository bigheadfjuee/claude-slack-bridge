/**
 * Persistent authorisation store.
 *
 * Which Slack users may drive Claude has to outlive the process — otherwise a
 * restart silently re-locks everyone who completed the handshake. The file is
 * plain JSON so an operator can read and edit it without tooling, and a corrupt
 * file degrades to "nobody is authorised" rather than crashing the bridge at
 * startup.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthStore } from "./authenticator.js";

interface AuthFile {
  version: number;
  users: string[];
}

function parse(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as Partial<AuthFile>;
    if (Array.isArray(parsed.users)) {
      return parsed.users.filter((id): id is string => typeof id === "string");
    }
  } catch {
    // Fall through to the empty list.
  }
  return [];
}

export class FileAuthStore implements AuthStore {
  private readonly path: string;
  private users: Set<string>;

  constructor(path: string) {
    this.path = path;
    this.users = new Set(this.load());
  }

  private load(): string[] {
    try {
      return parse(readFileSync(this.path, "utf8"));
    } catch {
      return [];
    }
  }

  private save(): void {
    const payload: AuthFile = { version: 1, users: [...this.users].sort() };
    mkdirSync(dirname(this.path), { recursive: true });
    // Write-then-rename: a concurrent reader sees the old file or the new one,
    // never a half-written one.
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }

  isAuthorized(userId: string): boolean {
    return this.users.has(userId);
  }

  authorize(userId: string): void {
    if (this.users.has(userId)) return;
    this.users.add(userId);
    this.save();
  }

  revoke(userId: string): void {
    if (!this.users.delete(userId)) return;
    this.save();
  }

  list(): string[] {
    return [...this.users].sort();
  }
}
