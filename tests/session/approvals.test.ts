import { describe, expect, it, vi } from "vitest";
import { ApprovalRegistry } from "../../src/session/approvals.js";

const req = (over: Partial<Parameters<ApprovalRegistry["register"]>[0]> = {}) => ({
  channel: "C1",
  threadTs: "100.1",
  toolName: "Bash",
  input: { command: "ls" },
  resolve: vi.fn(),
  ...over,
});

describe("ApprovalRegistry", () => {
  it("registers a request and returns a stable id", () => {
    const reg = new ApprovalRegistry();
    const pending = reg.register(req());
    expect(pending.id).toMatch(/^[A-Za-z0-9_-]{6,}$/);
    expect(reg.get(pending.id)).toBe(pending);
  });

  it("gives distinct ids to concurrent requests", () => {
    const reg = new ApprovalRegistry();
    const a = reg.register(req());
    const b = reg.register(req());
    expect(a.id).not.toBe(b.id);
  });

  it("allows: resolves the promise with updatedInput", () => {
    const reg = new ApprovalRegistry();
    const resolve = vi.fn();
    const { id } = reg.register(req({ resolve }));
    expect(reg.decide(id, { kind: "allow" })).toBe(true);
    expect(resolve).toHaveBeenCalledWith({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(reg.get(id)).toBeUndefined();
  });

  it("denies: resolves the promise with a message", () => {
    const reg = new ApprovalRegistry();
    const resolve = vi.fn();
    const { id } = reg.register(req({ resolve }));
    reg.decide(id, { kind: "deny", reason: "not on my watch" });
    expect(resolve).toHaveBeenCalledWith({ behavior: "deny", message: "not on my watch" });
  });

  it("deny is the default reason when none is given", () => {
    const reg = new ApprovalRegistry();
    const resolve = vi.fn();
    const { id } = reg.register(req({ resolve }));
    reg.decide(id, { kind: "deny" });
    const arg = resolve.mock.calls[0]?.[0];
    expect(arg.behavior).toBe("deny");
    expect(typeof arg.message).toBe("string");
    expect(arg.message.length).toBeGreaterThan(0);
  });

  it("returns false when deciding an unknown id", () => {
    expect(new ApprovalRegistry().decide("nope", { kind: "allow" })).toBe(false);
  });

  it("cannot decide the same request twice", () => {
    const reg = new ApprovalRegistry();
    const resolve = vi.fn();
    const { id } = reg.register(req({ resolve }));
    expect(reg.decide(id, { kind: "allow" })).toBe(true);
    expect(reg.decide(id, { kind: "allow" })).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("records the tool name and reason for rendering", () => {
    const reg = new ApprovalRegistry();
    const { id } = reg.register(req({ toolName: "Write", decisionReason: "writes a file" }));
    const got = reg.get(id);
    expect(got?.toolName).toBe("Write");
    expect(got?.decisionReason).toBe("writes a file");
  });

  it("denies every pending request for a conversation on cancelAll", () => {
    const reg = new ApprovalRegistry();
    const a = vi.fn();
    const b = vi.fn();
    reg.register(req({ resolve: a }));
    reg.register(req({ resolve: b, channel: "C2" }));
    const denied = reg.cancelAll("C1/100.1");
    expect(denied).toBe(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(reg.size()).toBe(1);
  });

  it("reports its size", () => {
    const reg = new ApprovalRegistry();
    reg.register(req());
    reg.register(req());
    expect(reg.size()).toBe(2);
    reg.cancelAll("C1/100.1");
    expect(reg.size()).toBe(0);
  });

  it("lists pending requests for a conversation", () => {
    const reg = new ApprovalRegistry();
    reg.register(req());
    reg.register(req({ channel: "C2" }));
    expect(reg.list("C1/100.1")).toHaveLength(1);
    expect(reg.list()).toHaveLength(2);
  });
});
