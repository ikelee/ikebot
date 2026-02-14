import { expect } from "vitest";
import type { MsgContext } from "../../gateway/auto-reply/templating.js";
import { normalizeChatType } from "../../gateway/channels/chat-type.js";
import { resolveConversationLabel } from "../../gateway/channels/conversation-label.js";
import { validateSenderIdentity } from "../../gateway/channels/sender-identity.js";

export function expectInboundContextContract(ctx: MsgContext) {
  expect(validateSenderIdentity(ctx)).toEqual([]);

  expect(ctx.Body).toBeTypeOf("string");
  expect(ctx.BodyForAgent).toBeTypeOf("string");
  expect(ctx.BodyForCommands).toBeTypeOf("string");

  const chatType = normalizeChatType(ctx.ChatType);
  if (chatType && chatType !== "direct") {
    const label = ctx.ConversationLabel?.trim() || resolveConversationLabel(ctx);
    expect(label).toBeTruthy();
  }
}
