import { describe, expect, it } from "vitest";
import {
  ClaudeSession,
  type QueryFactory,
  type QueryLike,
} from "../../src/claude/session.js";
import type { PermissionMode, SessionEvent } from "../../src/types/index.js";

/** A scripted stand-in for the SDK `Query`: yields messages, then idles. */
function makeFakeQuery(script: unknown[]) {
  const state = {
    /** Messages the session forwarded as user turns. */
    prompt: [] as unknown[],
    interrupts: 0,
    closed: false,
    permissionModes: [] as PermissionMode[],
    canUseTool: undefined as
      | ((name: string, input: Record<string, unknown>) => Promise<unknown>)
      | undefined,
    options: undefined as Record<string, unknown> | undefined,
    release: () => {},
    model: undefined as string | undefined,
  };
  const gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });

  const query: QueryLike = {
    async *[Symbol.asyncIterator]() {
      for (const message of script) yield message;
      await gate;
    },
    async interrupt() {
      state.interrupts += 1;
      state.release();
    },
    async setPermissionMode(mode) {
      state.permissionModes.push(mode);
    },
    async setModel(model) {
      state.model = model;
    },
    close() {
      state.closed = true;
      state.release();
    },
  };

  const factory: QueryFactory = ({ prompt, options }) => {
    state.options = options;
    state.canUseTool = (options as { canUseTool?: typeof state.canUseTool }).canUseTool;
    void (async () => {
      for await (const message of prompt) state.prompt.push(message);
    })();
    return query;
  };

  return { state, factory };
}

const INIT = {
  type: "system",
  subtype: "init",
  session_id: "sess-abc",
  cwd: "/work",
  model: "claude-sonnet-4-5",
};
const TEXT = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
};
const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "sess-abc",
  result: "hello",
};

/** Drain a session's event stream until it ends or the timeout expires. */
async function drain(
  session: ClaudeSession,
  opts: { until?: (events: SessionEvent[]) => boolean; timeoutMs?: number } = {},
): Promise<SessionEvent[]> {
  const collected: SessionEvent[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? 2000);
  const iterator = session.events[Symbol.asyncIterator]();
  while (Date.now() < deadline) {
    const race = await Promise.race([
      iterator.next(),
      new Promise<{ done: true }>((resolve) =>
        setTimeout(() => resolve({ done: true }), Math.max(0, deadline - Date.now())),
      ),
    ]);
    if (race.done) break;
    collected.push((race as IteratorYieldResult<SessionEvent>).value);
    if (opts.until?.(collected) === true) break;
  }
  return collected;
}

describe("ClaudeSession — lifecycle", () => {
  it("reports running while the query is open and stopped after close", async () => {
    const { factory } = makeFakeQuery([INIT]);
    const session = new ClaudeSession({ cwd: "/work" }, { queryFn: factory });
    expect(session.isRunning).toBe(false);
    session.start();
    expect(session.isRunning).toBe(true);
    await drain(session, { until: (e) => e.some((x) => x.type === "init") });
    session.close();
    expect(session.isRunning).toBe(false);
  });

  it("captures the session id from the init message", async () => {
    const { factory } = makeFakeQuery([INIT]);
    const session = new ClaudeSession({ cwd: "/work" }, { queryFn: factory });
    session.start();
    await drain(session, { until: (e) => e.some((x) => x.type === "init") });
    expect(session.sessionId).toBe("sess-abc");
    session.close();
  });
});

describe("ClaudeSession — event translation", () => {
  it("emits parsed events in order and stops at the result", async () => {
    const { factory } = makeFakeQuery([INIT, TEXT, RESULT]);
    const session = new ClaudeSession({ cwd: "/work" }, { queryFn: factory });
    session.start();
    const events = await drain(session, { until: (e) => e.some((x) => x.type === "result") });
    expect(events.map((e) => e.type)).toEqual(["init", "text", "result"]);
    session.close();
  });

  it("turns a thrown query error into an error event instead of a crash", async () => {
    const factory: QueryFactory = () => ({
      // biome-ignore lint/correctness/useYield: deliberate failure
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        throw new Error("sdk exploded");
      },
      async interrupt() {},
      async setPermissionMode() {},
      async setModel() {},
      close() {},
    });
    const session = new ClaudeSession({ cwd: "/work" }, { queryFn: factory });
    session.start();
    const events = await drain(session, { until: (e) => e.some((x) => x.type === "error") });
    expect(events.at(-1)).toMatchObject({ type: "error", message: "sdk exploded" });
    session.close();
  });
});

describe("ClaudeSession — input", () => {
  it("forwards a sent message to the SDK prompt as a user turn", async () => {
    const { state, factory } = makeFakeQuery([INIT]);
    const session = new ClaudeSession({ cwd: "/work" }, { queryFn: factory });
    session.start();
    session.send("do the thing");
    await new Promise((r) => setTimeout(r, 50));
    expect(state.prompt).toHaveLength(1);
    expect(state.prompt[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
    });
    session.close();
  });

  it("refuses to send on a session that was never started", () => {
    const { factory } = makeFakeQuery([INIT]);
    const session = new ClaudeSession({ cwd: "/work" }, { queryFn: factory });
    expect(() => session.send("hi")).toThrow(/not started/i);
  });
});

describe("ClaudeSession — SDK options", () => {
  it("passes cwd, model, permission mode and partial-message flag through", async () => {
    const { state, factory } = makeFakeQuery([INIT]);
    const session = new ClaudeSession(
      {
        cwd: "/srv/project",
        model: "claude-opus-4-1",
        permissionMode: "acceptEdits",
        extraArgs: { "add-dir": "/tmp" },
      },
      { queryFn: factory },
    );
    session.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(state.options).toMatchObject({
      cwd: "/srv/project",
      model: "claude-opus-4-1",
      permissionMode: "acceptEdits",
      includePartialMessages: true,
      extraArgs: { "add-dir": "/tmp" },
    });
    session.close();
  });

  it("forwards resume when the session is asked to continue an earlier one", async () => {
    const { state, factory } = makeFakeQuery([INIT]);
    const session = new ClaudeSession({ cwd: "/work", resume: "sess-old" }, { queryFn: factory });
    session.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(state.options).toMatchObject({ resume: "sess-old" });
    session.close();
  });

  it("wires canUseTool so the injected handler decides tool calls", async () => {
    const seen: Array<{ name: string; input: Record<string, unknown> }> = [];
    const { state, factory } = makeFakeQuery([INIT]);
    const session = new ClaudeSession(
      { cwd: "/work" },
      {
        queryFn: factory,
        permissions: async (name, input) => {
          seen.push({ name, input });
          return { behavior: "allow", updatedInput: input };
        },
      },
    );
    session.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(state.canUseTool).toBeTypeOf("function");
    const decision = await state.canUseTool?.("Bash", { command: "ls" });
    expect(seen).toEqual([{ name: "Bash", input: { command: "ls" } }]);
    expect(decision).toMatchObject({ behavior: "allow" });
    session.close();
  });
});

describe("ClaudeSession — control", () => {
  it("interrupt() delegates to the underlying query", async () => {
    const { state, factory } = makeFakeQuery([INIT]);
    const session = new ClaudeSession({ cwd: "/work" }, { queryFn: factory });
    session.start();
    await new Promise((r) => setTimeout(r, 20));
    await session.interrupt();
    expect(state.interrupts).toBe(1);
    session.close();
  });

  it("setPermissionMode() delegates to the underlying query", async () => {
    const { state, factory } = makeFakeQuery([INIT]);
    const session = new ClaudeSession({ cwd: "/work" }, { queryFn: factory });
    session.start();
    await new Promise((r) => setTimeout(r, 20));
    await session.setPermissionMode("plan");
    expect(state.permissionModes).toEqual(["plan"]);
    session.close();
  });

  it("close() closes the query and ends the event stream", async () => {
    const { state, factory } = makeFakeQuery([INIT]);
    const session = new ClaudeSession({ cwd: "/work" }, { queryFn: factory });
    session.start();
    session.close();
    expect(state.closed).toBe(true);
    expect(session.isRunning).toBe(false);
    await expect(drain(session, { timeoutMs: 500 })).resolves.toBeDefined();
  });
});
