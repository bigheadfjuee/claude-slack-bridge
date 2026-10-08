import { describe, expect, it } from "vitest";
import { COMMANDS, commandHelp, parseCommand } from "../../src/bridge/commands.js";

describe("parseCommand", () => {
  it("returns null for ordinary chat", () => {
    expect(parseCommand("please fix the bug")).toBeNull();
  });

  it("parses a bare command", () => {
    expect(parseCommand("/help")).toEqual({ name: "help", args: [] });
  });

  it("parses a command with arguments", () => {
    expect(parseCommand("/model opus")).toEqual({ name: "model", args: ["opus"] });
  });

  it("splits arguments on whitespace and drops empties", () => {
    expect(parseCommand("/cwd   /tmp   x ")).toEqual({ name: "cwd", args: ["/tmp", "x"] });
  });

  it("lower-cases the command name but preserves argument case", () => {
    expect(parseCommand("/MODEL Opus")).toEqual({ name: "model", args: ["Opus"] });
  });

  it("tolerates a leading @mention", () => {
    expect(parseCommand("<@U123BOT> /stop")).toEqual({ name: "stop", args: [] });
  });

  it("is not fooled by a slash inside a sentence", () => {
    expect(parseCommand("see the file /etc/hosts")).toBeNull();
  });

  it("is not fooled by an absolute path on its own line", () => {
    expect(parseCommand("/usr/local/bin")).toBeNull();
  });

  it("returns null for a lone slash", () => {
    expect(parseCommand("/")).toBeNull();
  });

  it("knows every advertised command", () => {
    for (const name of ["help", "stop", "new", "status", "sessions", "resume", "model", "mode", "cwd", "whoami"]) {
      expect(COMMANDS).toContain(name);
    }
  });

  it("marks unknown-looking slash words as unknown rather than chat", () => {
    expect(parseCommand("/frobnicate")).toEqual({ name: "frobnicate", args: [] });
  });
});

describe("commandHelp", () => {
  it("documents every command in COMMANDS", () => {
    const help = commandHelp();
    for (const name of COMMANDS) expect(help).toContain(`/${name}`);
  });

  it("mentions what /stop does", () => {
    expect(commandHelp()).toMatch(/\/stop/);
  });
});
