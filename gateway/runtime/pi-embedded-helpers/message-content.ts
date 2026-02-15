import { formatRawAssistantErrorForUi } from "./errors.js";

function extractTextBlocks(content: unknown, opts?: { includeThinking?: boolean }): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const thinkingParts: string[] = [];
  const textParts: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(record.text);
    }
    if (
      opts?.includeThinking &&
      record.type === "thinking" &&
      typeof record.thinking === "string"
    ) {
      thinkingParts.push(record.thinking);
    }
  }

  const thinkingText = thinkingParts.join("\n").trim();
  const contentText = textParts.join("\n").trim();
  if (opts?.includeThinking && thinkingText) {
    return `[thinking]\n${thinkingText}${contentText ? `\n\n${contentText}` : ""}`;
  }
  return contentText;
}

/**
 * Extract text (and optionally thinking) from an assistant message.
 * Model-agnostic: works for any model with text/thinking content blocks.
 */
export function extractTextFromMessage(
  message: unknown,
  opts?: { includeThinking?: boolean },
): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  const text = extractTextBlocks(record.content, opts);
  if (text) {
    return text;
  }

  const stopReason = typeof record.stopReason === "string" ? record.stopReason : "";
  if (stopReason !== "error") {
    return "";
  }

  const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : "";
  return formatRawAssistantErrorForUi(errorMessage);
}
