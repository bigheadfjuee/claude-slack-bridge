import { describe, expect, it } from "vitest";
import type { ClaudeSession } from "../../src/claude/session.js";
import { type ManagedSession, SessionManager } from "../../src/session/manager.js";

/** A stand-in ClaudeSession that records what the manager asked of it. */
function fakeSession(id: string) {
  return {
    id,
    sent: [] as string[],
    closed: false,
    isRunning: true,
    sessionId: id,
    send(text: string) {
      this.sent.push(text);
    },
    async interrupt() {},
    async setPermissionMode() {},
    async setModel() {},
    close() {
      this.closed = true;
      this.isRunning = false;
    },
  };
}

function makeManager(over: { maxSessions?: number; now?: () => number } = {}) {
  const created: Array<ReturnType<typeof fakeSession> & { key: string }> = [];
  let counter = 0;
  const manager = new SessionManager({
    maxSessions: over.maxSessions ?? 10,
    now: over.now ?? (() => Date.now()),
    create: (key) => {
      counter += 1;
      const session = fakeSession(`sess-${counter}`) as unknown as ClaudeSession &
        ReturnType<typeof fakeSession>;
      Object.assign(session, { key });
      created.push(session as never);
      return session as unknown as ClaudeSession;
    },
  });
  return { manager, created };
}

describe("SessionManager", () => {
  it("creates a session on first use and reuses it afterwards", () => {
    const { manager, created } = makeManager();
    const first = manager.getOrCreate("C1:thread-a", { cwd: "/work" });
    const second = manager.getOrCreate("C1:thread-a", { cwd: "/work" });
    expect(second).toBe(first);
    expect(created).toHaveLength(1);
  });

  it("keeps separate sessions for separate conversations", () => {
    const { manager } = makeManager();
    const a = manager.getOrCreate("C1:thread-a", { cwd: "/work" });
    const b = manager.getOrCreate("C1:thread-b", { cwd: "/work" });
    expect(a).not.toBe(b);
    expect(manager.size).toBe(2);
  });

  it("returns the recorded cwd and creation time for each conversation", () => {
    let clock = 1000;
    const { manager } = makeManager({ now: () => clock });
    manager.getOrCreate("C1:a", { cwd: "/srv/one" });
    clock = 2000;
    const record = manager.get("C1:a") as ManagedSession;
    expect(record).toMatchObject({ key: "C1:a", cwd: "/srv/one", createdAt: 1000 });
  });

  it("forgets a conversation on remove and closes its session", () => {
    const { manager, created } = makeManager();
    manager.getOrCreate("C1:a", { cwd: "/work" });
    expect(manager.remove("C1:a")).toBe(true);
    expect(created[0]?.closed).toBe(true);
    expect(manager.get("C1:a")).toBeUndefined();
    expect(manager.size).toBe(0);
  });

  it("reports false when removing something that was never there", () => {
    const { manager } = makeManager();
    expect(manager.remove("nope")).toBe(false);
  });

  it("evicts the least-recently-used idle session at the cap", () => {
    let clock = 0;
    const { manager } = makeManager({ maxSessions: 2, now: () => clock });

    manager.getOrCreate("C1:old", { cwd: "/a" });
    clock = 10;
    manager.getOrCreate("C1:new", { cwd: "/b" });
    clock = 20;
    // Touch "old" so "new" becomes the least-recently-used.
    manager.touch("C1:old");
    clock = 30;
    manager.getOrCreate("C1:third", { cwd: "/c" });

    expect(manager.get("C1:old")).toBeDefined();
    expect(manager.get("C1:new")).toBeUndefined();
    expect(manager.size).toBe(2);
  });

  it("prefers an idle victim over a busy one when making room", () => {
    let clock = 0;
    const { manager } = makeManager({ maxSessions: 2, now: () => clock });
    manager.getOrCreate("C1:busy", { cwd: "/a" });
    manager.markWorking("C1:busy");
    clock = 10;
    manager.getOrCreate("C1:idle", { cwd: "/b" });

    clock = 20;
    manager.getOrCreate("C1:third", { cwd: "/c" });

    // The busy session survives even though it is the least recently used.
    expect(manager.get("C1:busy")).toBeDefined();
    expect(manager.get("C1:idle")).toBeUndefined();
    expect(manager.size).toBe(2);
  });

  it("refuses to start a session rather than kill work in progress", () => {
    let clock = 0;
    const { manager } = makeManager({ maxSessions: 2, now: () => clock });
    manager.getOrCreate("C1:busy-a", { cwd: "/a" });
    manager.markWorking("C1:busy-a");
    clock = 10;
    manager.getOrCreate("C1:busy-b", { cwd: "/b" });
    manager.markWorking("C1:busy-b");

    clock = 20;
    expect(() => manager.getOrCreate("C1:third", { cwd: "/c" })).toThrow(/busy/i);
    expect(manager.get("C1:busy-a")).toBeDefined();
    expect(manager.get("C1:busy-b")).toBeDefined();
    expect(manager.size).toBe(2);
  });

  it("lists live conversations with their status and cwd", () => {
    let clock = 0;
    const { manager } = makeManager({ now: () => clock });
    manager.getOrCreate("C1:a", { cwd: "/a", model: "claude-opus-4-1" });
    clock = 5;
    manager.getOrCreate("C1:b", { cwd: "/b" });
    manager.markWorking("C1:b");

    expect(manager.list()).toEqual([
      { key: "C1:a", cwd: "/a", model: "claude-opus-4-1", status: "idle", createdAt: 0, lastActivity: 0 },
      { key: "C1:b", cwd: "/b", model: undefined, status: "working", createdAt: 5, lastActivity: 5 },
    ]);
  });

  it("tracks status transitions", () => {
    const { manager } = makeManager();
    manager.getOrCreate("C1:a", { cwd: "/a" });
    expect(manager.get("C1:a")?.status).toBe("idle");
    manager.markWorking("C1:a");
    expect(manager.get("C1:a")?.status).toBe("working");
    manager.markIdle("C1:a");
    expect(manager.get("C1:a")?.status).toBe("idle");
  });

  it("records the Claude session id once known", () => {
    const { manager } = makeManager();
    manager.getOrCreate("C1:a", { cwd: "/a" });
    manager.recordSessionId("C1:a", "real-claude-id");
    expect(manager.get("C1:a")?.claudeSessionId).toBe("real-claude-id");
  });

  it("stops every session on shutdown", () => {
    const { manager, created } = makeManager();
    manager.getOrCreate("C1:a", { cwd: "/a" });
    manager.getOrCreate("C1:b", { cwd: "/b" });
    manager.stopAll();
    expect(created.every((s) => s.closed)).toBe(true);
    expect(manager.size).toBe(0);
  });
});
