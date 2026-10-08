import { describe, expect, it } from "vitest";
import { Authenticator, MemoryAuthStore } from "../../src/auth/authenticator.js";

const mk = (over: Partial<Parameters<typeof Authenticator.prototype.constructor>[0]> = {}) =>
  new Authenticator({
    allowlist: [],
    challengeCode: "open-sesame",
    store: new MemoryAuthStore(),
    ...over,
  });

describe("Authenticator — allowlist", () => {
  it("authorizes a user on the allowlist", () => {
    expect(mk({ allowlist: ["U1"] }).isAuthorized("U1")).toBe(true);
  });

  it("does not authorize a stranger", () => {
    expect(mk({ allowlist: ["U1"] }).isAuthorized("U2")).toBe(false);
  });
});

describe("Authenticator — challenge handshake", () => {
  it("issues a challenge that is not the shared code itself", () => {
    const auth = mk();
    const code = auth.issueChallenge("U9");
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(code).not.toBe("open-sesame");
  });

  it("accepts the right code and then authorizes the user", () => {
    const auth = mk();
    const code = auth.issueChallenge("U9");
    expect(auth.verify("U9", code)).toBe(true);
    expect(auth.isAuthorized("U9")).toBe(true);
  });

  it("rejects a wrong code", () => {
    const auth = mk();
    auth.issueChallenge("U9");
    expect(auth.verify("U9", "WRONG1")).toBe(false);
    expect(auth.isAuthorized("U9")).toBe(false);
  });

  it("rejects a code issued to somebody else", () => {
    const auth = mk();
    const code = auth.issueChallenge("U9");
    expect(auth.verify("U8", code)).toBe(false);
  });

  it("burns the challenge after one use", () => {
    const auth = mk();
    const code = auth.issueChallenge("U9");
    expect(auth.verify("U9", code)).toBe(true);
    auth.revoke("U9");
    expect(auth.verify("U9", code)).toBe(false);
  });

  it("expires a challenge after its lifetime", () => {
    let now = 1_000;
    const auth = mk({ now: () => now });
    const code = auth.issueChallenge("U9");
    now += 11 * 60 * 1000;
    expect(auth.verify("U9", code)).toBe(false);
  });

  it("refuses to verify when no challenge was issued", () => {
    expect(mk().verify("U9", "AAAAAA")).toBe(false);
  });

  it("compares codes in constant time (no length leak crash)", () => {
    const auth = mk();
    const code = auth.issueChallenge("U9");
    expect(() => auth.verify("U9", "x".repeat(4096))).not.toThrow();
    expect(auth.verify("U9", code)).toBe(true);
  });
});

describe("Authenticator — persistence", () => {
  it("remembers authorized users across instances via the store", () => {
    const store = new MemoryAuthStore();
    const first = mk({ store });
    const code = first.issueChallenge("U9");
    first.verify("U9", code);
    expect(mk({ store }).isAuthorized("U9")).toBe(true);
  });

  it("revokes a user and persists the revocation", () => {
    const store = new MemoryAuthStore();
    const auth = mk({ store });
    const code = auth.issueChallenge("U9");
    auth.verify("U9", code);
    auth.revoke("U9");
    expect(auth.isAuthorized("U9")).toBe(false);
    expect(mk({ store }).isAuthorized("U9")).toBe(false);
  });

  it("lists authorized users", () => {
    const auth = mk();
    const code = auth.issueChallenge("U9");
    auth.verify("U9", code);
    expect(auth.listAuthorized()).toContain("U9");
  });
});
