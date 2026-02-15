/**
 * Shared types and helpers for the reply pipeline (context, tokens, thinking, etc.).
 * Use for a single import path when you need pipeline-wide shared pieces.
 *
 * @see docs/reference/reply-lifecycle.md
 */
export type {
  MsgContext,
  FinalizedMsgContext,
  TemplateContext,
  OriginatingChannelType,
} from "../templating.js";
export { applyTemplate } from "../templating.js";
export { finalizeInboundContext } from "../reply/inbound-context.js";
export type { FinalizeInboundContextOptions } from "../reply/inbound-context.js";
export type {
  GetReplyOptions,
  ReplyPayload,
  ModelSelectedContext,
  BlockReplyContext,
} from "../types.js";
export { SILENT_REPLY_TOKEN } from "../tokens.js";
export type { ThinkLevel, VerboseLevel, ReasoningLevel, ElevatedLevel } from "../thinking.js";
export {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  normalizeReasoningLevel,
  normalizeElevatedLevel,
} from "../thinking.js";
