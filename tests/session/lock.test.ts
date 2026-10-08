import { describe, expect, it } from "vitest";
import { SessionLock } from "../../src/session/lock.js";

describe("SessionLock", () => {
  it("grants the lock to the first caller", async () => {
    const lock = new SessionLock();
    expect(await lock.acquire("k", { timeoutMs: 100 })).toBe(true);
  });

  it("refuses a second holder while the lock is busy", async () => {
    const lock = new SessionLock();
    await lock.acquire("k", { timeoutMs: 100 });
    expect(await lock.acquire("k", { timeoutMs: 50 })).toBe(false);
  });

  it("allows the next caller after release", async () => {
    const lock = new SessionLock();
    await lock.acquire("k", { timeoutMs: 100 });
    lock.release("k");
    expect(await lock.acquire("k", { timeoutMs: 100 })).toBe(true);
  });

  it("keeps locks for different keys independent", async () => {
    const lock = new SessionLock();
    await lock.acquire("a", { timeoutMs: 100 });
    expect(await lock.acquire("b", { timeoutMs: 100 })).toBe(true);
  });

  it("reports busy state", async () => {
    const lock = new SessionLock();
    expect(lock.isBusy("k")).toBe(false);
    await lock.acquire("k", { timeoutMs: 100 });
    expect(lock.isBusy("k")).toBe(true);
    lock.release("k");
    expect(lock.isBusy("k")).toBe(false);
  });

  it("ignores a release from a key that is not held", () => {
    const lock = new SessionLock();
    expect(() => lock.release("never")).not.toThrow();
  });

  it("queues a waiting caller and hands over the lock on release", async () => {
    const lock = new SessionLock();
    await lock.acquire("k", { timeoutMs: 100 });
    const waiter = lock.waitFor("k", { timeoutMs: 500 });
    setTimeout(() => lock.release("k"), 20);
    expect(await waiter).toBe(true);
  });

  it("gives up waiting after the timeout", async () => {
    const lock = new SessionLock();
    await lock.acquire("k", { timeoutMs: 100 });
    expect(await lock.waitFor("k", { timeoutMs: 30 })).toBe(false);
  });
});
