import { describe, expect, it, vi } from "vitest";
import { Authenticator } from "../../src/auth/authenticator.js";
import { Bridge, type BridgeDeps, type SlackLike } from "../../src/bridge/index.js";
import type { ClaudeSession, PermissionHandler } from "../../src/claude/session.js";
import { ApprovalRegistry } from "../../src/session/approvals.js";
import { SessionLock } from "../../src/session/lock.js";
import { MemoryThreadStore, type ThreadStore } from "../../src/session/threads.js";
import type {
  PermissionDecision,
  SessionCatalog,
  SessionEvent,
  StoredSessionInfo,
} from "../../src/types/index.js";

/** A push-driven async iterable, standing in for a session's event stream. */
function stream<T>() {
  const buffer: T[] = [];
  const waiters: Array<(r: IteratorResult<T>) => void> = [];
  let done = false;
  return {
    push(value: T) {
      if (done) return;
      const w = waiters.shift();
      if (w) w({ value, done: false });
      else buffer.push(value);
    },
    end() {
      if (done) return;
      done = true;
      while (waiters.length) waiters.shift()?.({ value: undefined as never, done: true });
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next: () =>
            buffer.length > 0
              ? Promise.resolve({ value: buffer.shift() as T, done: false })
              : done
                ? Promise.resolve({ value: undefined as never, done: true })
                : new Promise((resolve) => waiters.push(resolve)),
        };
      },
    } as AsyncIterable<T>,
  };
}

interface FakeSession {
  key: string;
  sent: string[];
  interrupts: number;
  modes: string[];
  models: Array<string | undefined>;
  closed: boolean;
  isRunning: boolean;
  sessionId: string;
  events: AsyncIterable<SessionEvent>;
  permissions?: PermissionHandler;
  spec: Record<string, unknown>;
  send(text: string): void;
  interrupt(): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  setModel(model?: string): Promise<void>;
  close(): void;
  emit(event: SessionEvent): void;
}

function makeHarness(
  over: {
    challengeCode?: string;
    allowlist?: string[];
    workdir?: string;
    editIntervalMs?: number;
    now?: () => number;
    createSession?: BridgeDeps["createSession"];
    stored?: StoredSessionInfo[];
    threads?: ThreadStore;
  } = {},
) {
  const calls = {
    postMessage: [] as Array<{ channel: string; text: string; threadTs?: string; blocks?: unknown[] }>,
    updateMessage: [] as Array<{ channel: string; ts: string; text: string; blocks?: unknown[] }>,
    postEphemeral: [] as Array<{ channel: string; user: string; text: string }>,
  };
  let tsCounter = 0;
  const slack: SlackLike = {
    postMessage: vi.fn(async (args) => {
      calls.postMessage.push(args);
      tsCounter += 1;
      return `1000.${String(tsCounter).padStart(4, "0")}`;
    }),
    updateMessage: vi.fn(async (args) => {
      calls.updateMessage.push(args);
    }),
    postEphemeral: vi.fn(async (args) => {
      calls.postEphemeral.push(args);
    }),
  };

  const created: FakeSession[] = [];
  const byKey = new Map<string, FakeSession>();
  let clock = 0;
  const now = over.now ?? (() => clock);

  const createSession: BridgeDeps["createSession"] = (key, spec, permissions) => {
    const events = stream<SessionEvent>();
    const fake: FakeSession = {
      key,
      sent: [],
      interrupts: 0,
      modes: [],
      models: [],
      closed: false,
      isRunning: true,
      sessionId: `sess-${key}`,
      events: events.iterable,
      permissions,
      spec: spec as Record<string, unknown>,
      send(text) {
        this.sent.push(text);
      },
      async interrupt() {
        this.interrupts += 1;
      },
      async setPermissionMode(mode) {
        this.modes.push(mode);
      },
      async setModel(model) {
        this.models.push(model);
      },
      close() {
        this.closed = true;
        this.isRunning = false;
        events.end();
      },
      emit(event) {
        events.push(event);
      },
    };
    byKey.set(key, fake);
    created.push(fake);
    return fake as unknown as ClaudeSession;
  };

  const auth = new Authenticator({
    allowlist: over.allowlist ?? ["U_ALLOWED"],
    challengeCode: over.challengeCode,
    now,
  });

  const stored = over.stored ?? [];
  const catalog: SessionCatalog = {
    list: vi.fn(async ({ limit }: { dir?: string; limit: number }) => stored.slice(0, limit)),
    get: vi.fn(async (id: string) => stored.find((info) => info.sessionId === id)),
  };
  const threads = over.threads ?? new MemoryThreadStore();

  const deps: BridgeDeps = {
    slack,
    catalog,
    threads,
    auth,
    approvals: new ApprovalRegistry(),
    locks: new SessionLock(),
    workdir: over.workdir ?? "/work",
    model: "claude-sonnet-4-5",
    permissionMode: "default",
    editIntervalMs: over.editIntervalMs ?? 0,
    now,
    createSession: over.createSession ?? createSession,
  };

  const bridge = new Bridge(deps);

  const flush = async () => {
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
  };
  const emit = async (key: string, event: SessionEvent) => {
    byKey.get(key)?.emit(event);
    await flush();
  };
  const last = (key: keyof typeof calls) => calls[key].at(-1);

  return {
    bridge,
    deps,
    catalog,
    threads,
    calls,
    created,
    byKey,
    auth,
    flush,
    emit,
    last,
    setClock: (v: number) => {
      clock = v;
    },
  };
}

const msg = (over: Record<string, unknown> = {}) => ({
  channel: "C1",
  ts: "111.222",
  user: "U_ALLOWED",
  text: "hello claude",
  ...over,
});

const KEY = "C1/111.222";

describe("Bridge — turn lifecycle", () => {
  it("creates a session for a new conversation and sends the prompt", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.sent).toEqual(["hello claude"]);
    expect(h.created[0]?.spec).toMatchObject({ cwd: "/work", model: "claude-sonnet-4-5" });
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });

  it("replies in the same thread, acknowledging before the first token", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    expect(h.calls.postMessage[0]).toMatchObject({ channel: "C1", threadTs: "111.222" });
    expect(h.calls.postMessage[0]?.text).toContain("working");
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });

  it("posts one Slack message per turn and edits it in place", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "text", text: "Hello", delta: false });
    await h.emit(KEY, { type: "text", text: " world", delta: false });
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;

    expect(h.calls.postMessage).toHaveLength(1);
    expect(h.calls.updateMessage.length).toBeGreaterThan(0);
    expect(h.calls.updateMessage[0]?.ts).toBe("1000.0001");
    expect(h.last("updateMessage")?.text).toContain("Hello");
    expect(h.last("updateMessage")?.text).toContain("world");
  });

  it("reuses the same session for a reply in the same thread", async () => {
    const h = makeHarness();
    const first = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await first;

    const second = h.bridge.handleMessage(msg({ ts: "222.333", thread_ts: "111.222", text: "again" }));
    await h.flush();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.sent).toEqual(["hello claude", "again"]);
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await second;
  });

  it("keeps separate sessions for separate threads", async () => {
    const h = makeHarness();
    const a = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await a;

    const b = h.bridge.handleMessage(msg({ ts: "999.000", text: "other thread" }));
    await h.flush();
    expect(h.created).toHaveLength(2);
    await h.emit("C1/999.000", { type: "result", sessionId: "s", isError: false, result: "" });
    await b;
  });

  it("refuses a second turn while the first is still running", async () => {
    const h = makeHarness();
    const first = h.bridge.handleMessage(msg());
    await h.flush();
    await h.bridge.handleMessage(msg({ ts: "333.444", thread_ts: "111.222", text: "hurry up" }));
    expect(h.created[0]?.sent).toEqual(["hello claude"]);
    const said = [...h.calls.postMessage, ...h.calls.postEphemeral].map((c) => c.text).join("\n");
    expect(said.toLowerCase()).toContain("busy");
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await first;
  });

  it("marks the session idle again once the turn ends", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
    expect(h.bridge.sessions.get(KEY)?.status).toBe("idle");
  });

  it("records Claude's session id on the record", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "init", sessionId: "claude-real-id" });
    expect(h.bridge.sessions.get(KEY)?.claudeSessionId).toBe("claude-real-id");
    await h.emit(KEY, { type: "result", sessionId: "claude-real-id", isError: false, result: "" });
    await p;
  });

  it("sends the message text only, not the routing metadata", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg({ text: "  trim me  " }));
    await h.flush();
    expect(h.created[0]?.sent).toEqual(["trim me"]);
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });
});

describe("Bridge — streaming throttle", () => {
  it("coalesces a burst of deltas into few Slack edits", async () => {
    const h = makeHarness({ editIntervalMs: 1500 });
    h.setClock(0);
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "text", text: "first", delta: false });
    const afterFirst = h.calls.updateMessage.length;
    for (let i = 0; i < 60; i += 1) {
      await h.emit(KEY, { type: "text", text: `tok${i} `, delta: true });
    }
    expect(h.calls.updateMessage.length - afterFirst).toBeLessThan(4);
    h.setClock(5000);
    await h.emit(KEY, { type: "text", text: " tail", delta: true });
    expect(h.calls.updateMessage.length).toBeGreaterThan(afterFirst);
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });

  it("always performs the final update even inside the throttle window", async () => {
    const h = makeHarness({ editIntervalMs: 10_000 });
    h.setClock(0);
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    // A delta lands inside the throttle window, so its streamed edit is
    // coalesced away and no updateMessage is sent. The turn's result must
    // still force the last text out, or the final answer is lost.
    await h.emit(KEY, { type: "text", text: "final words", delta: true });
    const beforeResult = h.calls.updateMessage.length;
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
    expect(h.calls.updateMessage.length).toBeGreaterThan(beforeResult);
    expect(h.last("updateMessage")?.text).toContain("final words");
  });

  it("updates immediately on a tool call even inside the throttle window", async () => {
    const h = makeHarness({ editIntervalMs: 10_000 });
    h.setClock(0);
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "tool", activity: { name: "Bash", input: { command: "ls" } } });
    expect(h.last("updateMessage")?.text ?? h.calls.postMessage.at(-1)?.text ?? "").toContain("Bash");
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });
});

describe("Bridge — failures", () => {
  it("reports an errored turn without pretending it succeeded", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "error", message: "agent crashed" });
    await h.emit(KEY, { type: "result", sessionId: "s", isError: true, result: "agent crashed" });
    await p;
    expect(h.last("updateMessage")?.text ?? "").toContain("agent crashed");
  });

  it("releases the conversation even when the turn fails", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "error", message: "boom" });
    await h.emit(KEY, { type: "result", sessionId: "s", isError: true, result: "boom" });
    await p;
    expect(h.bridge.sessions.get(KEY)?.status).toBe("idle");
  });

  it("answers the user when the session cannot be created at all", async () => {
    const h = makeHarness({
      createSession: () => {
        throw new Error("all Claude sessions are busy; cannot start another");
      },
    });
    await h.bridge.handleMessage(msg());
    const said = [...h.calls.postMessage, ...h.calls.postEphemeral].map((c) => c.text).join("\n");
    expect(said.toLowerCase()).toContain("busy");
  });
});

describe("Bridge — authorization", () => {
  it("turns away an unknown user with a challenge instead of reaching Claude", async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(msg({ user: "U_STRANGER" }));
    expect(h.created).toHaveLength(0);
    const said = [...h.calls.postMessage, ...h.calls.postEphemeral].map((c) => c.text).join("\n");
    expect(said.toLowerCase()).toMatch(/code|authoris|authoriz|access/);
  });

  it("admits a user who presents the challenge code correctly", async () => {
    const h = makeHarness({ challengeCode: "SWORDFISH" });
    await h.bridge.handleMessage(msg({ user: "U_NEW", text: "SWORDFISH" }));
    expect(h.auth.isAuthorized("U_NEW")).toBe(true);
    expect(h.created).toHaveLength(0); // the code itself is not a prompt
  });

  it("rejects a wrong code without authorising the user", async () => {
    const h = makeHarness({ challengeCode: "SWORDFISH" });
    await h.bridge.handleMessage(msg({ user: "U_NEW", text: "GUESS" }));
    expect(h.auth.isAuthorized("U_NEW")).toBe(false);
    expect(h.created).toHaveLength(0);
  });
});

describe("Bridge — commands", () => {
  it("/help answers with the command list and never reaches an agent", async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(msg({ text: "/help" }));
    expect(h.created).toHaveLength(0);
    const blocks = JSON.stringify(h.last("postMessage")?.blocks ?? []);
    for (const cmd of ["new", "status", "stop", "sessions"]) expect(blocks).toContain(cmd);
  });

  it("/status reports this thread's directory", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
    await h.bridge.handleMessage(msg({ text: "/status" }));
    expect(h.last("postMessage")?.text ?? "").toContain("/work");
  });

  it("/stop interrupts the running turn", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.bridge.handleMessage(msg({ text: "/stop", ts: "444.555", thread_ts: "111.222" }));
    expect(h.created[0]?.interrupts).toBe(1);
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });

  it("/reset forgets the thread's session and closes it", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
    await h.bridge.handleMessage(msg({ text: "/reset", ts: "555.666", thread_ts: "111.222" }));
    expect(h.bridge.sessions.get(KEY)).toBeUndefined();
    expect(h.created[0]?.closed).toBe(true);
  });

  it("/sessions lists the Claude sessions saved on disk", async () => {
    const h = makeHarness({
      stored: [
        { sessionId: "abcdef12-0000-0000-0000-000000000000", summary: "fix login", lastModified: 0, cwd: "/repo" },
      ],
    });
    await h.bridge.handleMessage(msg({ text: "/sessions /repo" }));
    expect(h.catalog.list).toHaveBeenCalledWith({ dir: "/repo", limit: 15 });
    const blocks = JSON.stringify(h.last("postMessage")?.blocks ?? []);
    expect(blocks).toContain("abcdef12");
    expect(blocks).toContain("fix login");
    expect(blocks).toContain("/repo");
  });

  it("/new starts a fresh session even though the thread already had one", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
    await h.bridge.handleMessage(msg({ text: "/new", ts: "666.777", thread_ts: "111.222" }));
    expect(h.created[0]?.closed).toBe(true);
    const fresh = h.bridge.handleMessage(msg({ ts: "888.999", thread_ts: "111.222", text: "start over" }));
    await h.flush();
    expect(h.created).toHaveLength(2);
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await fresh;
  });

  it("treats a filesystem path as chat, not a command", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg({ text: "/usr/local/bin is where it lives" }));
    await h.flush();
    expect(h.created[0]?.sent).toEqual(["/usr/local/bin is where it lives"]);
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });

  it("says so when /stop is used while nothing is running", async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(msg({ text: "/stop" }));
    expect((h.last("postMessage")?.text ?? "").toLowerCase()).toMatch(/nothing|no turn|idle/);
  });
});

describe("Bridge — approvals", () => {
  async function ask(h: ReturnType<typeof makeHarness>, tool: string, input: Record<string, unknown>) {
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    const decision = h.created[0]?.permissions?.(tool, input) as Promise<PermissionDecision>;
    await h.flush();
    return { p, decision };
  }

  it("posts an approval card showing exactly what would run", async () => {
    const h = makeHarness();
    const { p, decision } = await ask(h, "Bash", { command: "rm -rf /tmp/x" });
    const card = h.calls.postMessage.find((c) => JSON.stringify(c.blocks ?? []).includes("Bash"));
    expect(card).toBeDefined();
    expect(JSON.stringify(card?.blocks)).toContain("rm -rf /tmp/x");
    const id = h.bridge.approvals.list()[0]?.id as string;
    h.bridge.approvals.decide(id, { kind: "allow" });
    await expect(decision).resolves.toMatchObject({ behavior: "allow" });
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });

  it("resolves to allow when the human clicks Allow once", async () => {
    const h = makeHarness();
    const { p, decision } = await ask(h, "Write", { file_path: "/x" });
    const id = h.bridge.approvals.list()[0]?.id as string;
    await h.bridge.handleAction({ actionId: "approval_allow", value: id, userId: "U_ALLOWED", channel: "C1" });
    await expect(decision).resolves.toMatchObject({ behavior: "allow" });
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });

  it("resolves to deny when the human clicks Deny", async () => {
    const h = makeHarness();
    const { p, decision } = await ask(h, "Bash", { command: "curl evil.example" });
    const id = h.bridge.approvals.list()[0]?.id as string;
    await h.bridge.handleAction({ actionId: "approval_deny", value: id, userId: "U_ALLOWED", channel: "C1" });
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });

  it("strips the buttons once a decision is made", async () => {
    const h = makeHarness();
    const { p, decision } = await ask(h, "Bash", { command: "ls" });
    const id = h.bridge.approvals.list()[0]?.id as string;
    await h.bridge.handleAction({ actionId: "approval_allow", value: id, userId: "U_ALLOWED", channel: "C1" });
    await decision;
    const settled = h.calls.updateMessage.some((c) => {
      const blocks = JSON.stringify(c.blocks ?? []);
      return blocks.includes("Bash") && !blocks.includes("approval_allow");
    });
    expect(settled).toBe(true);
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });

  it("records the approving user on the settled card", async () => {
    const h = makeHarness({ allowlist: ["U_ALLOWED", "U_APPROVER"] });
    const { p, decision } = await ask(h, "Bash", { command: "ls" });
    const id = h.bridge.approvals.list()[0]?.id as string;
    await h.bridge.handleAction({ actionId: "approval_allow", value: id, userId: "U_APPROVER", channel: "C1" });
    await decision;
    expect(h.calls.updateMessage.some((c) => JSON.stringify(c.blocks ?? []).includes("U_APPROVER"))).toBe(
      true,
    );
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });

  it("loosens the session mode after Always allow, so the same tool stops asking", async () => {
    const h = makeHarness();
    const { p, decision } = await ask(h, "Bash", { command: "ls" });
    const id = h.bridge.approvals.list()[0]?.id as string;
    await h.bridge.handleAction({ actionId: "approval_always", value: id, userId: "U_ALLOWED", channel: "C1" });
    await decision;
    await h.flush();
    expect(h.created[0]?.modes).toContain("acceptEdits");
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });

  it("tells the user when a button is stale instead of failing silently", async () => {
    const h = makeHarness();
    await h.bridge.handleAction({
      actionId: "approval_allow",
      value: "expired-id",
      userId: "U_ALLOWED",
      channel: "C1",
    });
    expect((h.last("postEphemeral")?.text ?? "").toLowerCase()).toMatch(/expired|no longer|unknown/);
  });

  it("does not let an unauthorised stranger answer a permission prompt", async () => {
    const h = makeHarness();
    const { p, decision } = await ask(h, "Bash", { command: "ls" });
    const id = h.bridge.approvals.list()[0]?.id as string;
    await h.bridge.handleAction({ actionId: "approval_allow", value: id, userId: "U_STRANGER", channel: "C1" });
    expect(h.bridge.approvals.get(id)).toBeDefined(); // still pending
    h.bridge.approvals.decide(id, { kind: "deny" });
    await decision;
    await h.emit(KEY, { type: "result", sessionId: "s", isError: false, result: "" });
    await p;
  });
});

const STORED_A: StoredSessionInfo = {
  sessionId: "aaaa1111-0000-0000-0000-000000000000",
  summary: "refactor auth",
  lastModified: 0,
  cwd: "/projects/app",
};
const STORED_B: StoredSessionInfo = {
  sessionId: "aaaa2222-0000-0000-0000-000000000000",
  summary: "write docs",
  lastModified: 0,
  cwd: "/projects/docs",
};

/** Run one full turn in the default thread. */
async function turn(h: ReturnType<typeof makeHarness>, text = "hello claude", sessionId = "claude-1") {
  const p = h.bridge.handleMessage(msg({ ts: `${Math.random()}`, thread_ts: "111.222", text }));
  await h.flush();
  await h.emit(KEY, { type: "init", sessionId, model: "m", cwd: "/x", tools: [] } as SessionEvent);
  await h.emit(KEY, { type: "result", sessionId, isError: false, result: "" });
  await p;
}

describe("Bridge — taking over CLI sessions", () => {
  it("/resume resumes a CLI session in the directory it was created in", async () => {
    const h = makeHarness({ stored: [STORED_A, STORED_B] });
    await h.bridge.handleMessage(msg({ text: `/resume ${STORED_A.sessionId}` }));
    await turn(h);
    expect(h.created[0]?.spec).toMatchObject({ cwd: "/projects/app", resume: STORED_A.sessionId });
    expect(h.created[0]?.spec.forkSession).toBeUndefined();
  });

  it("/resume accepts an unambiguous id prefix", async () => {
    const h = makeHarness({ stored: [STORED_A, STORED_B] });
    await h.bridge.handleMessage(msg({ text: "/resume aaaa2" }));
    await turn(h);
    expect(h.created[0]?.spec).toMatchObject({ cwd: "/projects/docs", resume: STORED_B.sessionId });
  });

  it("/resume refuses an ambiguous prefix and lists the candidates", async () => {
    const h = makeHarness({ stored: [STORED_A, STORED_B] });
    await h.bridge.handleMessage(msg({ text: "/resume aaaa" }));
    const text = h.last("postMessage")?.text ?? "";
    expect(text).toContain("matches 2 sessions");
    expect(text).toContain(STORED_A.sessionId);
    await turn(h);
    expect(h.created[0]?.spec.resume).toBeUndefined();
  });

  it("/resume reports an unknown id", async () => {
    const h = makeHarness({ stored: [STORED_A] });
    await h.bridge.handleMessage(msg({ text: "/resume zzzz" }));
    expect(h.last("postMessage")?.text ?? "").toContain("No Claude session matches");
  });

  it("/resume --fork branches the session instead of appending to it", async () => {
    const h = makeHarness({ stored: [STORED_A] });
    await h.bridge.handleMessage(msg({ text: "/resume aaaa1 --fork" }));
    await turn(h, "go", "forked-id");
    expect(h.created[0]?.spec).toMatchObject({ resume: STORED_A.sessionId, forkSession: true });
    expect(h.threads.get(KEY)?.sessionId).toBe("forked-id");
  });

  it("/resume refuses a session open in another thread unless forked", async () => {
    const h = makeHarness({ stored: [STORED_A] });
    await h.bridge.handleMessage(msg({ text: `/resume ${STORED_A.sessionId}` }));
    await turn(h, "hi", STORED_A.sessionId);

    const other = { channel: "C2", ts: "900.000", user: "U_ALLOWED" };
    await h.bridge.handleMessage({ ...other, text: `/resume ${STORED_A.sessionId}` });
    expect(h.last("postMessage")?.text ?? "").toContain("already open in another thread");

    await h.bridge.handleMessage({ ...other, text: `/resume ${STORED_A.sessionId} --fork` });
    expect(h.last("postMessage")?.text ?? "").toContain("fork");
  });

  it("/cwd followed by /resume does not lose the resume's directory", async () => {
    const h = makeHarness({ stored: [STORED_A] });
    await h.bridge.handleMessage(msg({ text: "/cwd /elsewhere" }));
    await h.bridge.handleMessage(msg({ text: "/resume aaaa1" }));
    await turn(h);
    expect(h.created[0]?.spec).toMatchObject({ cwd: "/projects/app", resume: STORED_A.sessionId });
  });
});

describe("Bridge — handing sessions to the CLI", () => {
  it("/handoff closes the live session and prints the resume command", async () => {
    const h = makeHarness({ stored: [{ ...STORED_A, sessionId: "claude-1", cwd: "/work" }] });
    await turn(h);
    await h.bridge.handleMessage(msg({ text: "/handoff" }));
    expect(h.created[0]?.closed).toBe(true);
    expect(h.bridge.sessions.get(KEY)).toBeUndefined();
    expect(h.last("postMessage")?.text ?? "").toContain("cd /work && claude --resume claude-1");
  });

  it("the next Slack message after /handoff resumes what the CLI left", async () => {
    const h = makeHarness({ stored: [{ ...STORED_A, sessionId: "claude-1", cwd: "/work" }] });
    await turn(h);
    await h.bridge.handleMessage(msg({ text: "/handoff" }));
    await turn(h, "back in slack", "claude-1");
    expect(h.created).toHaveLength(2);
    expect(h.created[1]?.spec).toMatchObject({ cwd: "/work", resume: "claude-1" });
  });

  it("/handoff refuses while a turn is running", async () => {
    const h = makeHarness();
    const p = h.bridge.handleMessage(msg());
    await h.flush();
    await h.emit(KEY, { type: "init", sessionId: "claude-1", model: "m", cwd: "/x", tools: [] } as SessionEvent);
    await h.bridge.handleMessage(msg({ text: "/handoff", ts: "222.333", thread_ts: "111.222" }));
    expect(h.last("postMessage")?.text ?? "").toContain("still working");
    expect(h.created[0]?.closed).toBe(false);
    await h.emit(KEY, { type: "result", sessionId: "claude-1", isError: false, result: "" });
    await p;
  });

  it("/handoff with no session says so", async () => {
    const h = makeHarness();
    await h.bridge.handleMessage(msg({ text: "/handoff" }));
    expect(h.last("postMessage")?.text ?? "").toContain("no Claude session");
  });

  it("/status shows how to continue in the CLI", async () => {
    const h = makeHarness();
    await turn(h);
    await h.bridge.handleMessage(msg({ text: "/status" }));
    expect(h.last("postMessage")?.text ?? "").toContain("claude --resume claude-1");
  });
});

describe("Bridge — thread persistence", () => {
  it("a thread resumes its session after a restart", async () => {
    const threads = new MemoryThreadStore();
    const stored = [{ ...STORED_A, sessionId: "claude-1", cwd: "/work" }];
    const first = makeHarness({ threads, stored });
    await turn(first);
    first.bridge.stop();

    const second = makeHarness({ threads, stored });
    await turn(second, "still there?", "claude-1");
    expect(second.created[0]?.spec).toMatchObject({ cwd: "/work", resume: "claude-1" });
  });

  it("drops a binding whose transcript no longer exists", async () => {
    const threads = new MemoryThreadStore();
    threads.set(KEY, { sessionId: "gone", cwd: "/work", updatedAt: 0 });
    const h = makeHarness({ threads });
    await turn(h);
    expect(h.created[0]?.spec.resume).toBeUndefined();
    expect(threads.get(KEY)?.sessionId).toBe("claude-1");
  });

  it("/new forgets the thread's binding", async () => {
    const h = makeHarness({ stored: [{ ...STORED_A, sessionId: "claude-1", cwd: "/work" }] });
    await turn(h);
    await h.bridge.handleMessage(msg({ text: "/new" }));
    expect(h.threads.get(KEY)).toBeUndefined();
    await turn(h, "fresh", "claude-2");
    expect(h.created[1]?.spec.resume).toBeUndefined();
  });
});
