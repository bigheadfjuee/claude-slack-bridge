/**
 * Persistent thread → Claude session bindings.
 *
 * The live `SessionManager` forgets everything when the process exits, so a
 * reply in an old Slack thread after a restart would otherwise start a blank
 * conversation. This store remembers which Claude session (and directory) each
 * thread last used, so the bridge can `resume` it on the next message — and so
 * a session handed off to the CLI can be picked back up from the same thread.
 *
 * Like the auth store, the file is plain JSON, written atomically, and a
 * corrupt file degrades to "no bindings" rather than crashing the bridge.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ThreadBinding {
  sessionId: string;
  cwd: string;
  updatedAt: number;
}

export interface ThreadStore {
  get(key: string): ThreadBinding | undefined;
  set(key: string, binding: ThreadBinding): void;
  delete(key: string): void;
}

/** In-memory store: the default when no file is configured, and for tests. */
export class MemoryThreadStore implements ThreadStore {
  private readonly bindings = new Map<string, ThreadBinding>();

  get(key: string): ThreadBinding | undefined {
    return this.bindings.get(key);
  }

  set(key: string, binding: ThreadBinding): void {
    this.bindings.set(key, binding);
  }

  delete(key: string): void {
    this.bindings.delete(key);
  }
}

interface ThreadFile {
  version: number;
  threads: Record<string, ThreadBinding>;
}

function isBinding(value: unknown): value is ThreadBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    typeof v.cwd === "string" &&
    typeof v.updatedAt === "number"
  );
}

function parse(text: string): Map<string, ThreadBinding> {
  const bindings = new Map<string, ThreadBinding>();
  try {
    const parsed = JSON.parse(text) as Partial<ThreadFile>;
    if (typeof parsed.threads === "object" && parsed.threads !== null) {
      for (const [key, value] of Object.entries(parsed.threads)) {
        if (isBinding(value)) bindings.set(key, value);
      }
    }
  } catch {
    // Fall through to the empty map.
  }
  return bindings;
}

export class FileThreadStore implements ThreadStore {
  private readonly path: string;
  private readonly bindings: Map<string, ThreadBinding>;

  constructor(path: string) {
    this.path = path;
    this.bindings = this.load();
  }

  private load(): Map<string, ThreadBinding> {
    try {
      return parse(readFileSync(this.path, "utf8"));
    } catch {
      return new Map();
    }
  }

  private save(): void {
    const payload: ThreadFile = {
      version: 1,
      threads: Object.fromEntries([...this.bindings].sort(([a], [b]) => a.localeCompare(b))),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }

  get(key: string): ThreadBinding | undefined {
    return this.bindings.get(key);
  }

  set(key: string, binding: ThreadBinding): void {
    const current = this.bindings.get(key);
    if (current?.sessionId === binding.sessionId && current.cwd === binding.cwd) return;
    this.bindings.set(key, binding);
    this.save();
  }

  delete(key: string): void {
    if (!this.bindings.delete(key)) return;
    this.save();
  }
}
