import { describe, expect, it } from "vitest";
import { buildQueryOptions, toUserTurn } from "../../src/claude/query.js";

describe("buildQueryOptions", () => {
  it("maps a session spec onto SDK options", () => {
    const options = buildQueryOptions({
      cwd: "/srv/project",
      model: "claude-opus-4-1",
      permissionMode: "acceptEdits",
      resume: "sess-old",
    });
    expect(options).toMatchObject({
      cwd: "/srv/project",
      model: "claude-opus-4-1",
      permissionMode: "acceptEdits",
      resume: "sess-old",
    });
  });

  it("enables partial messages so the bridge can stream", () => {
    expect(buildQueryOptions({ cwd: "/w" })).toMatchObject({ includePartialMessages: true });
  });

  it("defaults the permission mode rather than leaving it undefined", () => {
    expect(buildQueryOptions({ cwd: "/w" })).toMatchObject({ permissionMode: "default" });
  });

  it("forwards forkSession only alongside resume", () => {
    expect(buildQueryOptions({ cwd: "/w", resume: "s", forkSession: true })).toMatchObject({
      resume: "s",
      forkSession: true,
    });
    expect(buildQueryOptions({ cwd: "/w", forkSession: true })).not.toHaveProperty("forkSession");
    expect(buildQueryOptions({ cwd: "/w", resume: "s" })).not.toHaveProperty("forkSession");
  });

  it("omits resume when there is nothing to resume", () => {
    expect(buildQueryOptions({ cwd: "/w" })).not.toHaveProperty("resume");
  });

  it("threads extra CLI arguments through verbatim", () => {
    const options = buildQueryOptions({ cwd: "/w", extraArgs: { "add-dir": "/tmp" } });
    expect(options).toMatchObject({ extraArgs: { "add-dir": "/tmp" } });
  });

  it("attaches the permission callback when one is supplied", () => {
    const canUseTool = async () => ({ behavior: "allow", updatedInput: {} });
    const options = buildQueryOptions({ cwd: "/w" }, canUseTool as never);
    expect(options.canUseTool).toBe(canUseTool);
  });

  it("leaves the permission callback off when none is supplied", () => {
    expect(buildQueryOptions({ cwd: "/w" })).not.toHaveProperty("canUseTool");
  });
});

describe("toUserTurn", () => {
  it("wraps text as a user message the SDK accepts", () => {
    expect(toUserTurn("hello")).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
  });

  it("sets parent_tool_use_id to null for a top-level turn", () => {
    expect(toUserTurn("hi").parent_tool_use_id).toBeNull();
  });
});
