import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileAuthStore } from "../../src/auth/store.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csb-auth-"));
  path = join(dir, "authorized.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileAuthStore", () => {
  it("starts empty when the file does not exist", () => {
    const store = new FileAuthStore(path);
    expect(store.list()).toEqual([]);
    expect(store.isAuthorized("U1")).toBe(false);
  });

  it("reads users already recorded on disk", () => {
    writeFileSync(path, JSON.stringify({ users: ["U1", "U2"] }));
    const store = new FileAuthStore(path);
    expect(store.isAuthorized("U1")).toBe(true);
    expect(store.list()).toEqual(["U1", "U2"]);
  });

  it("persists an authorisation so the next process still trusts the user", () => {
    const store = new FileAuthStore(path);
    store.authorize("U_NEW");
    const reloaded = new FileAuthStore(path);
    expect(reloaded.isAuthorized("U_NEW")).toBe(true);
  });

  it("writes a versioned file that a human can read", () => {
    const store = new FileAuthStore(path);
    store.authorize("U_NEW");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed).toMatchObject({ version: 1 });
    expect(parsed.users).toContain("U_NEW");
  });

  it("revokes a user and persists the removal", () => {
    const store = new FileAuthStore(path);
    store.authorize("U1");
    store.revoke("U1");
    expect(new FileAuthStore(path).isAuthorized("U1")).toBe(false);
  });

  it("survives a corrupt file instead of crashing at startup", () => {
    writeFileSync(path, "{ this is not json");
    const store = new FileAuthStore(path);
    expect(store.list()).toEqual([]);
  });

  it("ignores entries that are not user-id strings", () => {
    writeFileSync(path, JSON.stringify({ users: ["U1", 42, null, "U2"] }));
    expect(new FileAuthStore(path).list()).toEqual(["U1", "U2"]);
  });

  it("writes atomically enough that a reader never sees a partial file", () => {
    const store = new FileAuthStore(path);
    store.authorize("U1");
    store.authorize("U2");
    // The file is always complete JSON, never a half-written buffer.
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });
});
