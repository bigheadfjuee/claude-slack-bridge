import { describe, expect, it } from "vitest";
import {
  conversationKey,
  isThreadReply,
  parseConversationKey,
} from "../../src/session/routing.js";

describe("conversationKey", () => {
  it("keys a top-level message by its own ts", () => {
    expect(conversationKey({ channel: "C1", ts: "100.1" })).toBe("C1/100.1");
  });

  it("keys a thread reply by the thread parent ts", () => {
    expect(conversationKey({ channel: "C1", ts: "200.2", thread_ts: "100.1" })).toBe("C1/100.1");
  });

  it("treats a message whose thread_ts equals its ts as top-level", () => {
    expect(conversationKey({ channel: "C1", ts: "100.1", thread_ts: "100.1" })).toBe("C1/100.1");
  });

  it("keeps different channels in different conversations", () => {
    expect(conversationKey({ channel: "C1", ts: "100.1" })).not.toBe(
      conversationKey({ channel: "C2", ts: "100.1" }),
    );
  });

  it("puts every reply in a thread under the same key", () => {
    const parent = conversationKey({ channel: "C1", ts: "100.1" });
    const reply1 = conversationKey({ channel: "C1", ts: "200.2", thread_ts: "100.1" });
    const reply2 = conversationKey({ channel: "C1", ts: "300.3", thread_ts: "100.1" });
    expect(reply1).toBe(parent);
    expect(reply2).toBe(parent);
  });
});

describe("parseConversationKey", () => {
  it("round-trips a key containing a slash-free channel id", () => {
    const key = conversationKey({ channel: "C1", ts: "100.1" });
    expect(parseConversationKey(key)).toEqual({ channel: "C1", threadTs: "100.1" });
  });

  it("throws on a key with no separator", () => {
    expect(() => parseConversationKey("nope")).toThrow();
  });
});

describe("isThreadReply", () => {
  it("is true for a reply", () => {
    expect(isThreadReply({ channel: "C1", ts: "200.2", thread_ts: "100.1" })).toBe(true);
  });

  it("is false for a top-level message", () => {
    expect(isThreadReply({ channel: "C1", ts: "100.1" })).toBe(false);
  });

  it("is false when thread_ts equals ts", () => {
    expect(isThreadReply({ channel: "C1", ts: "100.1", thread_ts: "100.1" })).toBe(false);
  });
});
