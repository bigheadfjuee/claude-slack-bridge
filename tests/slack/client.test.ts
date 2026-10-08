import { describe, expect, it, vi } from "vitest";
import { SlackClient } from "../../src/slack/client.js";

/** Minimal stand-in for Slack's WebClient, recording every call. */
function fakeWeb(handlers: {
  postMessage?: (args: Record<string, unknown>) => Promise<unknown>;
  update?: (args: Record<string, unknown>) => Promise<unknown>;
  ephemeral?: (args: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const calls = { postMessage: [] as unknown[], update: [] as unknown[], ephemeral: [] as unknown[] };
  const web = {
    chat: {
      postEphemeral: vi.fn(async (args: Record<string, unknown>) => {
        calls.ephemeral.push(args);
        return handlers.ephemeral ? handlers.ephemeral(args) : { ok: true };
      }),
      postMessage: vi.fn(async (args: Record<string, unknown>) => {
        calls.postMessage.push(args);
        return handlers.postMessage ? handlers.postMessage(args) : { ok: true, ts: "1700000000.000100" };
      }),
      update: vi.fn(async (args: Record<string, unknown>) => {
        calls.update.push(args);
        return handlers.update ? handlers.update(args) : { ok: true };
      }),
    },
  };
  return { web, calls };
}

describe("SlackClient.postMessage", () => {
  it("posts to the channel and returns the message ts", async () => {
    const { web, calls } = fakeWeb();
    const client = new SlackClient(web as never);
    const ts = await client.postMessage({ channel: "C1", text: "hello" });
    expect(calls.postMessage[0]).toMatchObject({ channel: "C1", text: "hello" });
    expect(ts).toBe("1700000000.000100");
  });

  it("threads the message when a thread timestamp is given", async () => {
    const { web, calls } = fakeWeb();
    const client = new SlackClient(web as never);
    await client.postMessage({ channel: "C1", threadTs: "111.222", text: "in thread" });
    expect(calls.postMessage[0]).toMatchObject({ thread_ts: "111.222" });
  });

  it("omits thread_ts entirely for a top-level message", async () => {
    const { web, calls } = fakeWeb();
    const client = new SlackClient(web as never);
    await client.postMessage({ channel: "C1", text: "top" });
    expect(calls.postMessage[0]).not.toHaveProperty("thread_ts");
  });

  it("passes blocks alongside the fallback text", async () => {
    const { web, calls } = fakeWeb();
    const client = new SlackClient(web as never);
    await client.postMessage({ channel: "C1", text: "fallback", blocks: [{ type: "divider" }] });
    expect(calls.postMessage[0]).toMatchObject({
      text: "fallback",
      blocks: [{ type: "divider" }],
    });
  });
});

describe("SlackClient.updateMessage", () => {
  it("edits the message identified by channel and ts", async () => {
    const { web, calls } = fakeWeb();
    const client = new SlackClient(web as never);
    await client.updateMessage({ channel: "C1", ts: "1700000000.000100", text: "v2" });
    expect(calls.update[0]).toMatchObject({ channel: "C1", ts: "1700000000.000100", text: "v2" });
  });

  it("includes blocks in the edit when provided", async () => {
    const { web, calls } = fakeWeb();
    const client = new SlackClient(web as never);
    await client.updateMessage({
      channel: "C1",
      ts: "t",
      text: "v2",
      blocks: [{ type: "divider" }],
    });
    expect(calls.update[0]).toMatchObject({ blocks: [{ type: "divider" }] });
  });
});

describe("SlackClient.postEphemeral", () => {
  it("sends a private note to one user", async () => {
    const { web, calls } = fakeWeb();
    const client = new SlackClient(web as never);
    await client.postEphemeral({ channel: "C1", user: "U1", text: "psst" });
    expect(calls.ephemeral[0]).toMatchObject({ channel: "C1", user: "U1", text: "psst" });
  });
});

describe("SlackClient rate limiting", () => {
  it("retries once after a 429 and then succeeds", async () => {
    let attempt = 0;
    const { web } = fakeWeb({
      postMessage: async () => {
        attempt += 1;
        if (attempt === 1) {
          const error = new Error("ratelimited") as Error & { code?: string; retryAfter?: number };
          error.code = "slack_webapi_rate_limited";
          error.retryAfter = 0;
          throw error;
        }
        return { ok: true, ts: "after.retry" };
      },
    });
    const client = new SlackClient(web as never, { sleepImpl: async () => {} });
    const ts = await client.postMessage({ channel: "C1", text: "hello" });
    expect(attempt).toBe(2);
    expect(ts).toBe("after.retry");
  });

  it("does not retry a non-rate-limit failure", async () => {
    let attempt = 0;
    const { web } = fakeWeb({
      postMessage: async () => {
        attempt += 1;
        const error = new Error("channel_not_found") as Error & { code?: string };
        error.code = "channel_not_found";
        throw error;
      },
    });
    const client = new SlackClient(web as never, { sleepImpl: async () => {} });
    await expect(client.postMessage({ channel: "C1", text: "hello" })).rejects.toThrow(
      /channel_not_found/,
    );
    expect(attempt).toBe(1);
  });

  it("gives up after the retry budget is exhausted", async () => {
    const { web } = fakeWeb({
      postMessage: async () => {
        const error = new Error("ratelimited") as Error & { code?: string };
        error.code = "slack_webapi_rate_limited";
        throw error;
      },
    });
    const client = new SlackClient(web as never, { sleepImpl: async () => {}, maxRetries: 2 });
    await expect(client.postMessage({ channel: "C1", text: "hello" })).rejects.toThrow(/ratelimit/);
  });
});
