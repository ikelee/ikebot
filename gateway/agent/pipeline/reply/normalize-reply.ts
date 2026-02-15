import type { ReplyPayload } from "../types.js";
import { sanitizeUserFacingText } from "../../../runtime/pi-embedded-helpers.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { HEARTBEAT_TOKEN, isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import { hasLineDirectives, parseLineDirectives } from "./line-directives.js";
import {
  resolveResponsePrefixTemplate,
  type ResponsePrefixContext,
} from "./response-prefix-template.js";

/**
 * When the model wraps its reply in meta-commentary (e.g. "Based on... Here is the response:\n```\nHi!\n```"),
 * extract only the inner reply so we don't send the preamble and code fence to the user.
 */
export function extractReplyFromMetaCommentary(text: string): string {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return text ?? "";
  }
  // "Here is the response:" (or similar) followed by a code fence → use content inside the fence.
  const hereIsMatch = /here is (?:the )?response:\s*$/im.exec(trimmed);
  if (hereIsMatch) {
    const afterLabel = trimmed.slice(hereIsMatch.index + hereIsMatch[0].length);
    const openFence = afterLabel.match(/^(\s*)```[^\n]*\n/s);
    if (openFence) {
      const innerStart = openFence.index! + openFence[0].length;
      const rest = afterLabel.slice(innerStart);
      const closeIdx = rest.indexOf("\n```");
      const inner = closeIdx >= 0 ? rest.slice(0, closeIdx) : rest;
      const extracted = inner.trimEnd();
      if (extracted.length > 0) {
        return extracted;
      }
    }
    // Single backtick fence: `\ncontent\n`
    const singleOpen = afterLabel.match(/^(\s*)`\s*\n/s);
    if (singleOpen) {
      const innerStart = singleOpen.index! + singleOpen[0].length;
      const rest = afterLabel.slice(innerStart);
      const closeIdx = rest.indexOf("\n`");
      const inner = closeIdx >= 0 ? rest.slice(0, closeIdx) : rest;
      const extracted = inner.trimEnd();
      if (extracted.length > 0) {
        return extracted;
      }
    }
  }
  // Whole reply is a single triple-backtick code block → unwrap.
  const singleBlock = /^```[^\n]*\n([\s\S]*?)```\s*$/m.exec(trimmed);
  if (singleBlock) {
    const inner = singleBlock[1].trim();
    if (inner.length > 0) {
      return inner;
    }
  }
  // Model returned a JSON envelope (e.g. type/text/fromMe/conversation_label) → use .text only.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && "text" in parsed) {
        const value = (parsed as { text: unknown }).text;
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }
    } catch {
      // Not valid JSON or no .text; keep original.
    }
  }
  return text;
}

export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat";

export type NormalizeReplyOptions = {
  responsePrefix?: string;
  /** Context for template variable interpolation in responsePrefix */
  responsePrefixContext?: ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  stripHeartbeat?: boolean;
  silentToken?: string;
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

export function normalizeReplyPayload(
  payload: ReplyPayload,
  opts: NormalizeReplyOptions = {},
): ReplyPayload | null {
  const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);
  const hasChannelData = Boolean(
    payload.channelData && Object.keys(payload.channelData).length > 0,
  );
  const trimmed = payload.text?.trim() ?? "";
  if (!trimmed && !hasMedia && !hasChannelData) {
    opts.onSkip?.("empty");
    return null;
  }

  const silentToken = opts.silentToken ?? SILENT_REPLY_TOKEN;
  let text = payload.text ?? undefined;
  if (text && isSilentReplyText(text, silentToken)) {
    if (!hasMedia && !hasChannelData) {
      opts.onSkip?.("silent");
      return null;
    }
    text = "";
  }
  if (text && !trimmed) {
    // Keep empty text when media exists so media-only replies still send.
    text = "";
  }

  const shouldStripHeartbeat = opts.stripHeartbeat ?? true;
  if (shouldStripHeartbeat && text?.includes(HEARTBEAT_TOKEN)) {
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    if (stripped.didStrip) {
      opts.onHeartbeatStrip?.();
    }
    if (stripped.shouldSkip && !hasMedia && !hasChannelData) {
      opts.onSkip?.("heartbeat");
      return null;
    }
    text = stripped.text;
  }

  if (text) {
    text = extractReplyFromMetaCommentary(text);
    text = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
  }
  if (!text?.trim() && !hasMedia && !hasChannelData) {
    opts.onSkip?.("empty");
    return null;
  }

  // Parse LINE-specific directives from text (quick_replies, location, confirm, buttons)
  let enrichedPayload: ReplyPayload = { ...payload, text };
  if (text && hasLineDirectives(text)) {
    enrichedPayload = parseLineDirectives(enrichedPayload);
    text = enrichedPayload.text;
  }

  // Resolve template variables in responsePrefix if context is provided
  const effectivePrefix = opts.responsePrefixContext
    ? resolveResponsePrefixTemplate(opts.responsePrefix, opts.responsePrefixContext)
    : opts.responsePrefix;

  if (
    effectivePrefix &&
    text &&
    text.trim() !== HEARTBEAT_TOKEN &&
    !text.startsWith(effectivePrefix)
  ) {
    text = `${effectivePrefix} ${text}`;
  }

  return { ...enrichedPayload, text };
}
