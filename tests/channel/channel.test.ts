import { describe, expect, it } from "vitest";
import { Authenticator } from "../../src/auth/authenticator.js";
import { SlackChannel } from "../../src/channel/index.js";
import { ACTION_ALLOW, ACTION_ALWAYS, ACTION_DENY } from "../../src/slack/blocks.js";

function setup() {
  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const ephemerals: Array<Record<string, unknown>> = [];
  const notes: Array<{ method: string; params: Record<string, unknown> }> = [];
  const channel = new SlackChannel({
    slack: {
      postMessage: async (args) => {
        posts.push(args);
        return `ts${posts.length}`;
      },
      updateMessage: async (args) => {
        updates.push(args);
      },
      postEphemeral: async (args) => {
        ephemerals.push(args);
      },
    },
    auth: new Authenticator({ allowlist: ["U_OK"] }),
    notify: async (method, params) => {
      notes.push({ method, params });
    },
  });
  return { channel, posts, updates, ephemerals, notes };
}

const hello = { channel: "C1", ts: "100.1", user: "U_OK", text: " hi " };
const request = { request_id: "abcde", tool_name: "Bash", description: "list", input_preview: '{"command":"ls"}' };

describe("SlackChannel", () => {
  it("forwards an authorised message as a channel event", async () => {
    const t = setup();
    await t.channel.handleMessage(hello);
    expect(t.notes).toEqual([
      {
        method: "notifications/claude/channel",
        params: { content: "hi", meta: { chat_id: "C1", thread_ts: "100.1", user: "U_OK" } },
      },
    ]);
  });

  it("never forwards an unauthorised message", async () => {
    const t = setup();
    await t.channel.handleMessage({ ...hello, user: "U_BAD" });
    expect(t.notes).toEqual([]);
    expect(t.ephemerals).toHaveLength(1);
  });

  it("replies only into chats an authorised user has spoken in", async () => {
    const t = setup();
    await expect(t.channel.reply({ chat_id: "C1", text: "x" })).rejects.toThrow(/has not messaged/);
    await t.channel.handleMessage(hello);
    await t.channel.reply({ chat_id: "C1", thread_ts: "100.1", text: "**done**" });
    expect(t.posts).toEqual([{ channel: "C1", text: "*done*", threadTs: "100.1" }]);
  });

  it("relays a permission request as a card without Always, and a click as a verdict", async () => {
    const t = setup();
    await t.channel.handleMessage(hello);
    await t.channel.handlePermissionRequest(request);
    expect(t.posts[0]).toMatchObject({ channel: "C1", threadTs: "100.1" });
    expect(JSON.stringify(t.posts[0]?.blocks)).not.toContain(ACTION_ALWAYS);

    await t.channel.handleAction({ actionId: ACTION_DENY, value: "abcde", userId: "U_OK", channel: "C1" });
    expect(t.notes.at(-1)).toEqual({
      method: "notifications/claude/channel/permission",
      params: { request_id: "abcde", behavior: "deny" },
    });
    expect(t.updates).toHaveLength(1);

    // 同一張卡片不能被按第二次。
    await t.channel.handleAction({ actionId: ACTION_ALLOW, value: "abcde", userId: "U_OK", channel: "C1" });
    expect(t.notes).toHaveLength(2);
  });

  it("ignores an approval click from an unauthorised user", async () => {
    const t = setup();
    await t.channel.handleMessage(hello);
    await t.channel.handlePermissionRequest(request);
    await t.channel.handleAction({ actionId: ACTION_ALLOW, value: "abcde", userId: "U_BAD", channel: "C1" });
    expect(t.notes).toHaveLength(1);
    expect(t.updates).toEqual([]);
  });
});
