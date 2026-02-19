/**
 * Ollama non-streaming streamFn: when tools are present, use non-streaming
 * chat completions. Ollama's streaming drops tool_calls; non-streaming works.
 *
 * @see https://github.com/ollama/ollama/issues/12557
 * @see https://github.com/badlogic/pi-mono/pull/1125
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  ToolCall,
} from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { isLogFullModelIoEnabled, shouldLogVerbose } from "../../globals.js";
import { checkVerboseSentinelExists } from "../../verbose-sentinel.js";
import { log } from "./logger.js";

const PREVIEW_CHARS = 400;
const VERBOSE_CHUNK_CHARS = 2000;
let ollamaRequestCounter = 0;

function isFullModelIoLogEnabled(): boolean {
  return shouldLogVerbose() || isLogFullModelIoEnabled() || checkVerboseSentinelExists();
}

function previewForLog(text: string, maxChars: number): string {
  const t = text?.trim() ?? "";
  if (!t) {
    return "(empty)";
  }
  const oneLine = t.replace(/\s+/g, " ").slice(0, maxChars);
  return oneLine.length < t.length ? `${oneLine}…` : oneLine;
}

function logLongContent(prefix: string, text: string): void {
  const t = text?.trim() ?? "";
  if (isFullModelIoLogEnabled() && t.length > 0) {
    for (let i = 0; i < t.length; i += VERBOSE_CHUNK_CHARS) {
      const chunk = t.slice(i, i + VERBOSE_CHUNK_CHARS);
      const part = Math.floor(i / VERBOSE_CHUNK_CHARS) + 1;
      const total = Math.ceil(t.length / VERBOSE_CHUNK_CHARS);
      const suffix = total > 1 ? ` (part ${part}/${total})` : "";
      log.info(`${prefix}${suffix}: ${chunk}`);
    }
  } else {
    log.info(`${prefix}: ${previewForLog(t, PREVIEW_CHARS)}`);
  }
}

function isOllamaProvider(model: { provider?: string; baseUrl?: string }): boolean {
  const p = (model.provider ?? "").trim().toLowerCase();
  const url = (model.baseUrl ?? "").trim();
  return p === "ollama" || url.includes(":11434");
}

function hasTools(context: { tools?: unknown[] }): boolean {
  const tools = context.tools;
  return Array.isArray(tools) && tools.length > 0;
}

/** Compat for Ollama (openai-completions API, non-Mistral/non-Zai). */
const OLLAMA_COMPAT = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens" as const,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresMistralToolIds: false,
  thinkingFormat: "openai" as const,
  openRouterRouting: {},
  vercelGatewayRouting: {},
  supportsStrictMode: true,
};

function convertToolsForOllama(
  tools: Array<{ name: string; description: string; parameters?: unknown }>,
) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? {},
      strict: false,
    },
  }));
}

function mapStopReason(reason: string | null): "stop" | "length" | "toolUse" {
  if (reason === "tool_calls" || reason === "function_call") {
    return "toolUse";
  }
  if (reason === "length") {
    return "length";
  }
  return "stop";
}

/** Convert OpenAI chat completion response to pi-ai AssistantMessage. */
function chatCompletionToAssistantMessage(
  choice: {
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  },
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  model: Model<"openai-completions">,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  const msg = choice.message;
  if (msg?.content && msg.content.trim()) {
    content.push({ type: "text", text: msg.content });
  }
  if (msg?.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments ?? "{}");
      } catch {
        // ignore
      }
      content.push({
        type: "toolCall",
        id: tc.id ?? `call_${Date.now()}`,
        name: tc.function?.name ?? "unknown",
        arguments: args,
      } as ToolCall);
    }
  }
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: mapStopReason(choice.finish_reason ?? null),
    timestamp: Date.now(),
  };
}

/** Convert a complete AssistantMessage into stream events and push to stream. */
function pushCompleteResultToStream(
  stream: AssistantMessageEventStream,
  msg: AssistantMessage,
): void {
  const output: AssistantMessage = { ...msg, content: [] };

  stream.push({ type: "start", partial: output });

  for (let i = 0; i < msg.content.length; i++) {
    const block = msg.content[i];
    output.content.push(block);

    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex: i, partial: { ...output } });
      if (block.text) {
        stream.push({
          type: "text_delta",
          contentIndex: i,
          delta: block.text,
          partial: { ...output },
        });
      }
      stream.push({
        type: "text_end",
        contentIndex: i,
        content: block.text,
        partial: { ...output },
      });
    } else if (block.type === "thinking") {
      stream.push({ type: "thinking_start", contentIndex: i, partial: { ...output } });
      if (block.thinking) {
        stream.push({
          type: "thinking_delta",
          contentIndex: i,
          delta: block.thinking,
          partial: { ...output },
        });
      }
      stream.push({
        type: "thinking_end",
        contentIndex: i,
        content: block.thinking,
        partial: { ...output },
      });
    } else if (block.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex: i, partial: { ...output } });
      const argsStr = JSON.stringify(block.arguments ?? {});
      if (argsStr) {
        stream.push({
          type: "toolcall_delta",
          contentIndex: i,
          delta: argsStr,
          partial: { ...output },
        });
      }
      stream.push({
        type: "toolcall_end",
        contentIndex: i,
        toolCall: block,
        partial: { ...output },
      });
    }
  }

  const reason =
    msg.stopReason === "toolUse" ? "toolUse" : msg.stopReason === "length" ? "length" : "stop";
  stream.push({ type: "done", reason, message: msg });
}

/**
 * Create a streamFn that uses non-streaming chat completions for Ollama when tools
 * are present. Fixes tool_calls being dropped by Ollama's streaming API.
 */
export function createOllamaNonStreamingStreamFn(baseStreamFn: StreamFn): StreamFn {
  return (model, context, options) => {
    if (!isOllamaProvider(model) || !hasTools(context)) {
      return baseStreamFn(model, context, options);
    }

    const stream = createAssistantMessageEventStream();
    const ollamaModel = model as Model<"openai-completions">;
    const modelForConvert = {
      ...ollamaModel,
      baseUrl: ollamaModel.baseUrl ?? "http://localhost:11434/v1",
      input: ollamaModel.input ?? ["text"],
    };

    void (async () => {
      try {
        const requestId = ++ollamaRequestCounter;
        const startedAt = Date.now();
        const baseUrl = (modelForConvert.baseUrl ?? "http://localhost:11434/v1").replace(/\/$/, "");
        const url = `${baseUrl}/chat/completions`;

        const messages = convertMessages(modelForConvert, context, OLLAMA_COMPAT);
        const tools = convertToolsForOllama(context.tools ?? []);
        const body = {
          model: ollamaModel.id,
          messages,
          tools,
          stream: false,
          max_completion_tokens: options?.maxTokens ?? 4096,
          temperature: options?.temperature ?? 0.3,
        };

        const lastMessage = messages.at(-1);
        const lastRole = lastMessage?.role ?? "unknown";
        const lastContent =
          typeof lastMessage?.content === "string"
            ? lastMessage.content
            : Array.isArray(lastMessage?.content)
              ? JSON.stringify(lastMessage.content)
              : "";
        log.info(
          `[ollama-stream-fn] req#${requestId} start model=${ollamaModel.id} messages=${messages.length} tools=${tools.length} maxTokens=${body.max_completion_tokens} temp=${body.temperature}`,
        );
        logLongContent(
          `[ollama-stream-fn] req#${requestId} input lastMessage role=${lastRole}`,
          lastContent,
        );
        logLongContent(`[ollama-stream-fn] req#${requestId} input body`, JSON.stringify(body));

        const controller = new AbortController();
        if (options?.signal) {
          options.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Ollama API error ${res.status}: ${errText}`);
        }
        const response = (await res.json()) as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
            };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = response.choices?.[0];
        if (!choice) {
          throw new Error("No choice in Ollama response");
        }
        const outputText = choice.message?.content ?? "";
        const toolCalls = choice.message?.tool_calls ?? [];
        log.info(
          `[ollama-stream-fn] req#${requestId} done ${Date.now() - startedAt}ms finish=${choice.finish_reason ?? "unknown"} toolCalls=${toolCalls.length} usage.in=${response.usage?.prompt_tokens ?? "?"} usage.out=${response.usage?.completion_tokens ?? "?"}`,
        );
        logLongContent(`[ollama-stream-fn] req#${requestId} output text`, outputText);
        if (toolCalls.length > 0) {
          logLongContent(
            `[ollama-stream-fn] req#${requestId} output toolCalls`,
            JSON.stringify(toolCalls),
          );
        }
        const msg = chatCompletionToAssistantMessage(choice, response.usage, ollamaModel);
        pushCompleteResultToStream(stream, msg);
      } catch (err) {
        log.warn(
          `[ollama-stream-fn] non-streaming complete failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          },
        });
      }
    })();

    return stream;
  };
}
