import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileThreadStore } from "../../src/session/threads.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csb-threads-"));
  path = join(dir, "threads.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileThreadStore", () => {
  it("starts empty when the file does not exist", () => {
    expect(new FileThreadStore(path).get("C1/1")).toBeUndefined();
  });

  it("persists a binding across instances", () => {
    new FileThreadStore(path).set("C1/1", { sessionId: "s1", cwd: "/w", updatedAt: 5 });
    expect(new FileThreadStore(path).get("C1/1")).toEqual({ sessionId: "s1", cwd: "/w", updatedAt: 5 });
  });

  it("deletes a binding durably", () => {
    const store = new FileThreadStore(path);
    store.set("C1/1", { sessionId: "s1", cwd: "/w", updatedAt: 5 });
    store.delete("C1/1");
    expect(new FileThreadStore(path).get("C1/1")).toBeUndefined();
  });

  it("writes a versioned, owner-only file", () => {
    new FileThreadStore(path).set("C1/1", { sessionId: "s1", cwd: "/w", updatedAt: 5 });
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
    // Windows 沒有 POSIX 權限位元，mode 一律是 0o666，只在 POSIX 上驗證
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt file as empty and ignores malformed entries", () => {
    writeFileSync(path, "{not json");
    expect(new FileThreadStore(path).get("C1/1")).toBeUndefined();
    writeFileSync(path, JSON.stringify({ threads: { a: { sessionId: 1 }, b: { sessionId: "s", cwd: "/w", updatedAt: 1 } } }));
    const store = new FileThreadStore(path);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")?.sessionId).toBe("s");
  });
});
