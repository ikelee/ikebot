/**
 * Reply pipeline runner — main entry for the full lifecycle (input → dispatch → phases → output).
 * Use this module when you need to run the reply pipeline or dispatch an inbound message.
 *
 * @see docs/reference/reply-lifecycle.md
 */
export {
  dispatchInboundMessage,
  dispatchInboundMessageWithBufferedDispatcher,
  dispatchInboundMessageWithDispatcher,
  type DispatchInboundResult,
} from "./dispatch.js";
export { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
export type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
export { getReplyFromConfig } from "./reply/get-reply.js";
export type { GetReplyOptions, ReplyPayload } from "./types.js";
