/**
 * 未授權使用者的挑戰碼流程，daemon 與 channel plugin 共用。
 *
 * 送來的文字若是正確的挑戰碼就授權；否則提示對方如何取得授權。
 */

import type { Authenticator } from "./authenticator.js";

interface EphemeralSender {
  postEphemeral(args: { channel: string; user: string; text: string }): Promise<void>;
}

export async function challengeUser(
  auth: Authenticator,
  slack: EphemeralSender,
  userId: string,
  channel: string,
  text: string,
): Promise<void> {
  if (text !== "" && auth.verify(userId, text)) {
    await slack.postEphemeral({
      channel,
      user: userId,
      text: ":white_check_mark: You're authorised — send a message to start talking to Claude.",
    });
    return;
  }
  await slack.postEphemeral({
    channel,
    user: userId,
    text: [
      ":lock: You're not authorised to use this bridge.",
      auth.hasPendingChallenge(userId)
        ? "Send the challenge code you were given to get access."
        : "Ask the bridge operator for the challenge code, then send it here.",
    ].join(" "),
  });
}
