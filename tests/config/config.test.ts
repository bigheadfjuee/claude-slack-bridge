import { describe, expect, it } from "vitest";
import { loadConfig, resolveWorkdir } from "../../src/config/index.js";

/** Base environment carrying the credentials the bridge needs to start. */
const TOKENS = {
  CLAUDE_SLACK_BOT_TOKEN: "xoxb-1",
  CLAUDE_SLACK_APP_TOKEN: "xapp-1",
} as const;

/** Build an env map with credentials, overriding with `over`. */
const env = (over: Record<string, string | undefined> = {}) => ({ ...TOKENS, ...over });

describe("loadConfig", () => {
  it("reads Slack tokens from the environment", () => {
    const cfg = loadConfig({ env: env(), file: {} });
    expect(cfg.slack).toEqual({ botToken: "xoxb-1", appToken: "xapp-1" });
  });

  it("splits and trims the allowlist", () => {
    const cfg = loadConfig({
      env: env({ CLAUDE_SLACK_ALLOWED_USERS: " U1 , U2 ,, U3 " }),
      file: {},
    });
    expect(cfg.allowedUsers).toEqual(["U1", "U2", "U3"]);
  });

  it("merges allowlists from file and environment without duplicates", () => {
    const cfg = loadConfig({
      env: env({ CLAUDE_SLACK_ALLOWED_USERS: "U2,U3" }),
      file: { allowedUsers: ["U1", "U2"] },
    });
    expect(cfg.allowedUsers).toEqual(["U1", "U2", "U3"]);
  });

  it("lets the environment win over the file for scalars", () => {
    const cfg = loadConfig({ env: env({ CLAUDE_SLACK_MODEL: "opus" }), file: { model: "haiku" } });
    expect(cfg.model).toBe("opus");
  });

  it("falls back to file values when the environment is silent", () => {
    const cfg = loadConfig({
      env: env(),
      file: { model: "haiku", permissionMode: "plan" },
    });
    expect(cfg.model).toBe("haiku");
    expect(cfg.permissionMode).toBe("plan");
  });

  it("defaults the permission mode to 'default'", () => {
    expect(loadConfig({ env: env(), file: {} }).permissionMode).toBe("default");
  });

  it("rejects an invalid permission mode", () => {
    expect(() =>
      loadConfig({ env: env({ CLAUDE_SLACK_PERMISSION_MODE: "yolo" }), file: {} }),
    ).toThrow(/permission mode/i);
  });

  it("ignores blank environment values instead of creating empty strings", () => {
    const cfg = loadConfig({ env: env({ CLAUDE_SLACK_MODEL: "   " }), file: {} });
    expect(cfg.model).toBeUndefined();
  });

  it("reports missing Slack credentials", () => {
    expect(() => loadConfig({ env: { CLAUDE_SLACK_BOT_TOKEN: "xoxb-1" }, file: {} })).toThrow(
      /CLAUDE_SLACK_APP_TOKEN/,
    );
    expect(() => loadConfig({ env: { CLAUDE_SLACK_APP_TOKEN: "xapp-1" }, file: {} })).toThrow(
      /CLAUDE_SLACK_BOT_TOKEN/,
    );
    expect(() => loadConfig({ env: {}, file: {} })).toThrow(/credentials/i);
  });

  it("does not require credentials when they are not needed (validate: false)", () => {
    const cfg = loadConfig({ env: {}, file: {}, validate: false });
    expect(cfg.slack?.botToken).toBeUndefined();
  });
});

describe("resolveWorkdir", () => {
  it("prefers an explicit value", () => {
    expect(resolveWorkdir("/tmp/x", { CLAUDE_SLACK_WORKDIR: "/tmp/y" }, "/home/me")).toBe("/tmp/x");
  });

  it("falls back to the environment", () => {
    expect(resolveWorkdir(undefined, { CLAUDE_SLACK_WORKDIR: "/tmp/y" }, "/home/me")).toBe("/tmp/y");
  });

  it("falls back to the home directory", () => {
    expect(resolveWorkdir(undefined, {}, "/home/me")).toBe("/home/me");
  });

  it("expands a leading tilde", () => {
    expect(resolveWorkdir("~/work", {}, "/home/me")).toBe("/home/me/work");
  });
});
